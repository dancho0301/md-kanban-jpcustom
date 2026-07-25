import * as vscode from 'vscode';
import { archiveTaskFromBoard } from './archive';
import {
  parseMarkdown,
  serializeToMarkdown,
  KanbanBoard,
  KanbanColumn,
  KanbanTask,
  Repeat,
  REPEAT_VALUES,
  generateId,
} from './kanbanParser';
import { openTaskSource } from './source';
import { getWebviewContent } from './webviewContent';

/**
 * One undoable step: the board as it was before the change, plus an optional
 * task to delete from another board file (archive/restore write two files).
 */
interface UndoEntry {
  board: KanbanBoard;
  cleanup?: { uri: vscode.Uri; taskId: string };
}

const MAX_UNDO_STEPS = 50;

export class KanbanPanel {
  public static readonly viewType = 'mdKanbanJp.boardView';
  private static panels: Map<string, KanbanPanel> = new Map();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _fileUri: vscode.Uri;
  private _board: KanbanBoard;
  private _undoStack: UndoEntry[] = [];
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(fileUri: vscode.Uri, extensionUri: vscode.Uri, taskId?: string) {
    const key = fileUri.toString();
    const existing = KanbanPanel.panels.get(key);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.One);
      if (taskId) {
        existing.openTaskInView(taskId);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      KanbanPanel.viewType,
      'カンバンボード',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
        ],
      }
    );

    const kanbanPanel = new KanbanPanel(panel, extensionUri, fileUri, taskId);
    KanbanPanel.panels.set(key, kanbanPanel);
    panel.reveal(vscode.ViewColumn.One);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, fileUri: vscode.Uri, private _pendingTaskId?: string) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._fileUri = fileUri;
    this._board = { title: '', columns: [] };

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (workspaceFolder) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          workspaceFolder,
          vscode.workspace.asRelativePath(fileUri)
        )
      );
      watcher.onDidChange(() => this._loadAndRefresh());
      this._disposables.push(watcher);
    }

    this._loadAndRefresh();
  }

  private async _loadAndRefresh() {
    try {
      const data = await vscode.workspace.fs.readFile(this._fileUri);
      const content = Buffer.from(data).toString('utf-8');
      this._board = parseMarkdown(content);
    } catch {
      this._board = {
        title: 'カンバンボード',
        columns: [
          { name: '未着手', tasks: [] },
          { name: '進行中', tasks: [] },
          { name: '完了', tasks: [] },
        ],
      };
    }

    this._panel.title = this._board.title;
    try {
      this._panel.webview.html = getWebviewContent(
        this._panel.webview,
        this._extensionUri,
        this._board,
        {
          canArchiveCards: !isArchiveBoardFile(this._fileUri),
          isArchiveBoard: isArchiveBoardFile(this._fileUri),
          canUndo: this._undoStack.length > 0,
        }
      );
      if (this._pendingTaskId) {
        const taskId = this._pendingTaskId;
        this._pendingTaskId = undefined;
        setTimeout(() => this._postOpenTask(taskId), 100);
      }
    } catch {
      vscode.window.showErrorMessage('カンバンボードを表示できませんでした。詳細はMD Kanbanの出力ログを確認してください。');
    }
  }

  private async _save() {
    const md = serializeToMarkdown(this._board);
    await vscode.workspace.fs.writeFile(this._fileUri, Buffer.from(md, 'utf-8'));
  }

  private async _handleMessage(message: { type: string; [key: string]: any }) {
    // Structural fields land on single markdown lines (# / ## / ### / #### / <!-- -->);
    // strip newlines so webview input cannot inject headings into the board file.
    for (const key of ['title', 'name', 'oldName', 'newName', 'column', 'fromColumn', 'toColumn', 'group', 'assignee', 'source', 'dueDate']) {
      if (typeof message[key] === 'string') {
        message[key] = toSingleLine(message[key]);
      }
    }
    if (Array.isArray(message.tags)) {
      message.tags = message.tags
        .filter((tag: unknown): tag is string => typeof tag === 'string')
        .map((tag: string) => toSingleLine(tag));
    }
    if (Array.isArray(message.subtasks)) {
      message.subtasks = message.subtasks
        .filter((subtask: any) => subtask && typeof subtask.title === 'string')
        .map((subtask: any) => ({ title: toSingleLine(subtask.title), done: !!subtask.done }));
    }

    // Snapshot before anything that changes the board. Archive/restore manage
    // their own entries because they also write a second board file.
    const isMutating = MUTATING_MESSAGE_TYPES.has(message.type);
    if (isMutating) {
      this._pushUndo();
    }

    switch (message.type) {
      case 'addTask': {
        const col = this._board.columns.find(c => c.name === message.column);
        if (col) {
          col.tasks.push({
            id: generateId(),
            title: message.title,
            description: message.description || '',
            tags: message.tags || [],
            priority: message.priority || 'medium',
            workload: message.workload || 'normal',
            dueDate: message.dueDate || '',
            subtasks: message.subtasks || [],
            assignee: message.assignee || '',
            source: message.source || '',
            group: message.group || '',
            repeat: normalizeRepeat(message.repeat),
          });
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'editTask': {
        for (const col of this._board.columns) {
          const task = col.tasks.find(t => t.id === message.taskId);
          if (task) {
            task.title = message.title;
            task.description = message.description || '';
            task.tags = message.tags || [];
            task.priority = message.priority || 'medium';
            task.workload = message.workload || 'normal';
            task.dueDate = message.dueDate || '';
            task.subtasks = message.subtasks || [];
            task.assignee = message.assignee || '';
            task.source = message.source || '';
            task.group = message.group || '';
            task.repeat = normalizeRepeat(message.repeat);
            await this._save();
            this._sendBoardUpdate();
            break;
          }
        }
        break;
      }

      case 'toggleSubtask': {
        for (const col of this._board.columns) {
          const task = col.tasks.find(t => t.id === message.taskId);
          if (task) {
            const index = message.index;
            const subtask = typeof index === 'number' ? task.subtasks?.[index] : undefined;
            if (subtask) {
              subtask.done = !!message.done;
              await this._save();
              this._sendBoardUpdate();
            }
            break;
          }
        }
        break;
      }

      case 'openExternal': {
        await openExternalLink(message.url);
        break;
      }

      case 'deleteTask': {
        for (const col of this._board.columns) {
          const idx = col.tasks.findIndex(t => t.id === message.taskId);
          if (idx !== -1) {
            col.tasks.splice(idx, 1);
            await this._save();
            this._sendBoardUpdate();
            break;
          }
        }
        break;
      }

      case 'moveTask': {
        const fromCol = this._board.columns.find(c => c.name === message.fromColumn);
        const toCol = this._board.columns.find(c => c.name === message.toColumn);
        if (fromCol && toCol) {
          const taskIdx = fromCol.tasks.findIndex(t => t.id === message.taskId);
          if (taskIdx !== -1) {
            const targetLength = toCol.tasks.length;
            const [task] = fromCol.tasks.splice(taskIdx, 1);
            let insertIdx = this._clampIndex(message.toIndex, targetLength);
            if (fromCol === toCol && taskIdx < insertIdx) {
              insertIdx--;
            }
            toCol.tasks.splice(insertIdx, 0, task);
            this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx);
            await this._save();
            this._sendBoardUpdate();
          }
        }
        break;
      }

      case 'moveTaskToGroup': {
        const fromCol = this._board.columns.find(c => c.name === message.fromColumn);
        const toCol = this._board.columns.find(c => c.name === message.toColumn);
        if (fromCol && toCol) {
          const taskIdx = fromCol.tasks.findIndex(t => t.id === message.taskId);
          if (taskIdx !== -1) {
            const targetLength = toCol.tasks.length;
            const [task] = fromCol.tasks.splice(taskIdx, 1);
            task.group = message.group ?? '';
            let insertIdx = this._getMoveInsertIndex(toCol, message, targetLength);
            toCol.tasks.splice(insertIdx, 0, task);
            this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx);
            await this._save();
            this._sendBoardUpdate();
          }
        }
        break;
      }

      case 'updateTaskGroup': {
        for (const col of this._board.columns) {
          const task = col.tasks.find(t => t.id === message.taskId);
          if (task) {
            task.group = message.group ?? '';
            await this._save();
            this._sendBoardUpdate();
            break;
          }
        }
        break;
      }

      case 'renameGroup': {
        const col = this._board.columns.find(c => c.name === message.column);
        if (col && message.oldName && message.newName) {
          for (const task of col.tasks) {
            if (task.group === message.oldName) {
              task.group = message.newName;
            }
          }
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'moveGroup': {
        const fromCol = this._board.columns.find(c => c.name === message.fromColumn);
        const toCol = this._board.columns.find(c => c.name === message.toColumn);
        const groupName = message.group;
        if (fromCol && toCol && groupName) {
          const groupTasks = fromCol.tasks.filter(t => t.group === groupName);
          if (groupTasks.length === 0) {
            break;
          }

          fromCol.tasks = fromCol.tasks.filter(t => t.group !== groupName);
          const targetGroupNames = Array.from(new Set(
            toCol.tasks
              .map(t => t.group)
              .filter((g): g is string => !!g && g !== groupName)
          ));
          const groupIndex = this._clampIndex(message.toGroupIndex, targetGroupNames.length);
          const beforeGroup = targetGroupNames[groupIndex];
          let insertIdx = 0;

          if (beforeGroup) {
            insertIdx = toCol.tasks.findIndex(t => t.group === beforeGroup);
          } else {
            const lastGroupedIdx = toCol.tasks.reduce((last, task, idx) => task.group ? idx : last, -1);
            insertIdx = lastGroupedIdx === -1 ? 0 : lastGroupedIdx + 1;
          }

          toCol.tasks.splice(insertIdx, 0, ...groupTasks);
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'addColumn': {
        const colName = (message.name || '').trim();
        if (colName && !this._board.columns.find(c => c.name === colName)) {
          this._board.columns.push({ name: colName, tasks: [] });
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'deleteColumn': {
        const idx = this._board.columns.findIndex(c => c.name === message.name);
        if (idx !== -1) {
          this._board.columns.splice(idx, 1);
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'renameColumn': {
        const col = this._board.columns.find(c => c.name === message.oldName);
        const newName = (message.newName || '').trim();
        if (col && newName) {
          col.name = newName;
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'moveColumn': {
        const fromIdx = this._board.columns.findIndex(c => c.name === message.name);
        if (fromIdx !== -1) {
          const targetLength = this._board.columns.length;
          const [column] = this._board.columns.splice(fromIdx, 1);
          const insertIdx = this._clampIndex(message.toIndex, targetLength - 1);
          this._board.columns.splice(insertIdx, 0, column);
          await this._save();
          this._sendBoardUpdate();
        }
        break;
      }

      case 'updateTitle': {
        this._board.title = message.title || 'カンバンボード';
        this._panel.title = this._board.title;
        await this._save();
        break;
      }

      case 'openMarkdown': {
        const doc = await vscode.workspace.openTextDocument(this._fileUri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        break;
      }

      case 'openSource': {
        await openTaskSource(message.source, this._fileUri);
        break;
      }

      case 'archiveTask': {
        if (isArchiveBoardFile(this._fileUri)) {
          this._panel.webview.postMessage({
            type: 'archiveResult',
            ok: false,
            message: 'archive.kanban.md内のカードは再度アーカイブできません。',
          });
          break;
        }

        this._pushUndo();
        try {
          const archived = await archiveTaskFromBoard(this._board, this._fileUri, {
            taskId: message.taskId,
            taskSnapshot: message.task,
            fromColumn: message.fromColumn,
            taskIndex: message.taskIndex,
          });

          if (archived) {
            // Undoing an archive must also delete the copy in the archive file.
            const entry = this._undoStack[this._undoStack.length - 1];
            if (entry) {
              entry.cleanup = { uri: archived.archiveUri, taskId: archived.archivedTaskId };
            }
            await this._save();
            await vscode.commands.executeCommand('md-kanban-jp.refreshBoards').then(undefined, () => undefined);
            this._sendBoardUpdate();
            this._panel.webview.postMessage({
              type: 'archiveResult',
              ok: true,
              message: `カードをarchive.kanban.mdの${archived.archiveColumnName}にアーカイブしました。`,
            });
            vscode.window.showInformationMessage(`カードをarchive.kanban.mdの${archived.archiveColumnName}にアーカイブしました。`);
          } else {
            this._undoStack.pop();
            this._panel.webview.postMessage({
              type: 'archiveResult',
              ok: false,
              message: 'カードが見つかりませんでした。',
            });
            vscode.window.showInformationMessage('カードが見つかりませんでした。');
          }
        } catch (error) {
          this._undoStack.pop();
          const messageText = error instanceof Error ? error.message : String(error);
          this._panel.webview.postMessage({
            type: 'archiveResult',
            ok: false,
            message: `カードをアーカイブできませんでした: ${messageText}`,
          });
          vscode.window.showErrorMessage(`カードをアーカイブできませんでした: ${messageText}`);
        }
        break;
      }

      case 'restoreTask': {
        await this._restoreTask(message.taskId);
        break;
      }

      case 'sortColumn': {
        const col = this._board.columns.find(c => c.name === message.name);
        if (col) {
          col.tasks = sortColumnTasks(col.tasks, message.by);
          await this._save();
          this._sendBoardUpdate();
          this._notify(`「${col.name}」を${sortLabel(message.by)}で並べ替えました。`);
        }
        break;
      }

      case 'undo': {
        const entry = this._undoStack.pop();
        if (!entry) {
          this._notify('元に戻せる操作がありません。', false);
          break;
        }

        this._board = entry.board;
        await this._save();
        if (entry.cleanup) {
          await removeTaskFromBoardFile(entry.cleanup.uri, entry.cleanup.taskId);
          await vscode.commands.executeCommand('md-kanban-jp.refreshBoards').then(undefined, () => undefined);
        }
        this._sendBoardUpdate();
        this._notify('操作を元に戻しました。');
        break;
      }
    }

    // A message that changed nothing should not leave an undo step behind.
    if (isMutating) {
      const entry = this._undoStack[this._undoStack.length - 1];
      if (entry && !entry.cleanup && JSON.stringify(entry.board) === JSON.stringify(this._board)) {
        this._undoStack.pop();
      }
    }
  }

  /** Move a card in archive.kanban.md back to the board it came from. */
  private async _restoreTask(taskId: unknown) {
    if (!isArchiveBoardFile(this._fileUri)) {
      this._notify('復元はアーカイブボードでのみ実行できます。', false);
      return;
    }

    let found: { column: KanbanColumn; index: number } | undefined;
    for (const column of this._board.columns) {
      const index = column.tasks.findIndex(task => task.id === taskId);
      if (index !== -1) {
        found = { column, index };
        break;
      }
    }
    if (!found) {
      this._notify('カードが見つかりませんでした。', false);
      return;
    }

    // Archive columns are named after the board file the card came from.
    const targetUri = getSiblingUri(this._fileUri, found.column.name);
    let targetBoard: KanbanBoard;
    try {
      const data = await vscode.workspace.fs.readFile(targetUri);
      targetBoard = parseMarkdown(Buffer.from(data).toString('utf-8'));
    } catch {
      this._notify(`復元先のボード「${found.column.name}」を開けませんでした。`, false);
      return;
    }

    if (targetBoard.columns.length === 0) {
      this._notify(`復元先のボード「${found.column.name}」に列がありません。`, false);
      return;
    }

    const task = found.column.tasks[found.index];
    const targetColumn =
      targetBoard.columns.find(column => column.name === task.archivedFrom) ?? targetBoard.columns[0];

    const restored: KanbanTask = { ...task, subtasks: task.subtasks.map(s => ({ ...s })), tags: [...task.tags] };
    delete restored.archivedFrom;
    targetColumn.tasks.push(restored);

    this._pushUndo({ uri: targetUri, taskId: restored.id });
    try {
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(serializeToMarkdown(targetBoard), 'utf-8'));
    } catch (error) {
      this._undoStack.pop();
      this._notify(`復元できませんでした: ${getErrorMessage(error)}`, false);
      return;
    }

    found.column.tasks.splice(found.index, 1);
    await this._save();
    await vscode.commands.executeCommand('md-kanban-jp.refreshBoards').then(undefined, () => undefined);
    this._sendBoardUpdate();
    this._notify(`「${found.column.name}」の${targetColumn.name}に復元しました。`);
  }

  /**
   * Completing a repeating card (moving it into a completed-style column)
   * puts the next occurrence back where the card came from.
   */
  private _spawnRepeatOccurrence(
    task: KanbanTask,
    fromColumn: KanbanColumn,
    toColumn: KanbanColumn,
    originalIndex: number
  ): void {
    if (!task.repeat || fromColumn === toColumn) {
      return;
    }

    const globs = getCompletedColumnGlobs();
    if (!isCompletedColumnName(toColumn.name, globs) || isCompletedColumnName(fromColumn.name, globs)) {
      return;
    }

    const next: KanbanTask = {
      ...task,
      id: generateId(),
      dueDate: nextDueDate(task.dueDate, task.repeat),
      subtasks: task.subtasks.map(subtask => ({ ...subtask, done: false })),
      tags: [...task.tags],
    };

    const insertAt = Math.max(0, Math.min(originalIndex, fromColumn.tasks.length));
    fromColumn.tasks.splice(insertAt, 0, next);
    this._notify(
      `繰り返しタスクの次回分を「${fromColumn.name}」に作成しました${next.dueDate ? `(期限: ${next.dueDate})` : ''}。`
    );
  }

  private _clampIndex(index: unknown, max: number): number {
    const value = typeof index === 'number' && Number.isFinite(index) ? index : max;
    return Math.max(0, Math.min(value, max));
  }

  private _getMoveInsertIndex(
    column: { tasks: { id: string }[] },
    message: { [key: string]: any },
    fallbackLength: number
  ): number {
    if (typeof message.beforeTaskId === 'string') {
      const beforeIdx = column.tasks.findIndex(t => t.id === message.beforeTaskId);
      if (beforeIdx !== -1) {
        return beforeIdx;
      }
    }

    if (typeof message.afterTaskId === 'string') {
      const afterIdx = column.tasks.findIndex(t => t.id === message.afterTaskId);
      if (afterIdx !== -1) {
        return afterIdx + 1;
      }
    }

    return this._clampIndex(message.toIndex, fallbackLength);
  }

  private _sendBoardUpdate() {
    this._panel.webview.postMessage({
      type: 'boardUpdate',
      board: this._board,
      canUndo: this._undoStack.length > 0,
    });
  }

  private _notify(message: string, ok = true) {
    this._panel.webview.postMessage({ type: 'notice', message, ok });
  }

  /** Snapshot the board before a change so it can be undone. */
  private _pushUndo(cleanup?: { uri: vscode.Uri; taskId: string }) {
    this._undoStack.push({ board: cloneBoard(this._board), cleanup });
    if (this._undoStack.length > MAX_UNDO_STEPS) {
      this._undoStack.shift();
    }
  }

  public openTaskInView(taskId: string) {
    this._panel.reveal(vscode.ViewColumn.One);
    this._postOpenTask(taskId);
  }

  private _postOpenTask(taskId: string) {
    this._panel.webview.postMessage({
      type: 'openTaskDetails',
      taskId,
    });
  }

  public dispose() {
    KanbanPanel.panels.delete(this._fileUri.toString());
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }
}

function isArchiveBoardFile(uri: vscode.Uri): boolean {
  return uri.path.split('/').pop()?.toLowerCase() === 'archive.kanban.md';
}

function toSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

const MUTATING_MESSAGE_TYPES = new Set([
  'addTask',
  'editTask',
  'toggleSubtask',
  'deleteTask',
  'moveTask',
  'moveTaskToGroup',
  'updateTaskGroup',
  'renameGroup',
  'moveGroup',
  'addColumn',
  'deleteColumn',
  'renameColumn',
  'moveColumn',
  'updateTitle',
  'sortColumn',
]);

function cloneBoard(board: KanbanBoard): KanbanBoard {
  return JSON.parse(JSON.stringify(board)) as KanbanBoard;
}

function normalizeRepeat(value: unknown): Repeat | undefined {
  return typeof value === 'string' && (REPEAT_VALUES as string[]).includes(value)
    ? (value as Repeat)
    : undefined;
}

/** Advance a due date by one repeat interval, clamping month-end overflow. */
function nextDueDate(dueDate: string, repeat: Repeat): string {
  const base = parseDateOnly(dueDate) ?? startOfToday();
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate());

  if (repeat === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (repeat === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else if (repeat === 'monthly') {
    addMonthsClamped(next, 1);
  } else {
    addMonthsClamped(next, 12);
  }

  const month = String(next.getMonth() + 1).padStart(2, '0');
  const day = String(next.getDate()).padStart(2, '0');
  return `${next.getFullYear()}-${month}-${day}`;
}

function addMonthsClamped(date: Date, months: number): void {
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  // e.g. Jan 31 + 1 month should land on the last day of February.
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
}

function parseDateOnly(value: string): Date | undefined {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!match) {
    return undefined;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getCompletedColumnGlobs(): string[] {
  const config = vscode.workspace.getConfiguration('mdKanbanJp');
  const value = config.get<unknown>('completedColumnGlobs');
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean)
    : [];
  return entries.length > 0
    ? entries
    : ['完了', 'クローズ', 'リリース済み', 'アーカイブ済み', 'Done', 'Closed', 'Shipped', 'Archived'];
}

function isCompletedColumnName(name: string, globs: string[]): boolean {
  const columnName = name.trim();
  return globs.some(glob => {
    const pattern = glob.trim();
    if (!pattern) {
      return false;
    }
    const regex = new RegExp(
      '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$',
      'i'
    );
    return regex.test(columnName);
  });
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function sortColumnTasks(tasks: KanbanTask[], by: unknown): KanbanTask[] {
  const compare = getTaskComparator(by);

  // Keep each group's cards contiguous so the Markdown structure stays valid;
  // groups themselves keep their first-appearance order.
  const order: string[] = [];
  const groups = new Map<string, KanbanTask[]>();
  for (const task of tasks) {
    const key = task.group || '';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(task);
  }

  const sorted: KanbanTask[] = [];
  for (const key of order) {
    sorted.push(...groups.get(key)!.sort(compare));
  }
  return sorted;
}

function getTaskComparator(by: unknown): (a: KanbanTask, b: KanbanTask) => number {
  if (by === 'priority') {
    return (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) ||
      a.title.localeCompare(b.title, 'ja');
  }
  if (by === 'title') {
    return (a, b) => a.title.localeCompare(b.title, 'ja');
  }
  // Due date: earliest first, undated cards last.
  return (a, b) => {
    if (!a.dueDate && !b.dueDate) {
      return a.title.localeCompare(b.title, 'ja');
    }
    if (!a.dueDate) {
      return 1;
    }
    if (!b.dueDate) {
      return -1;
    }
    return a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, 'ja');
  };
}

function sortLabel(by: unknown): string {
  if (by === 'priority') {
    return '優先度順';
  }
  if (by === 'title') {
    return 'タイトル順';
  }
  return '期限順';
}

function getSiblingUri(uri: vscode.Uri, fileName: string): vscode.Uri {
  const parentPath = uri.path.replace(/\/[^/]*$/, '');
  return uri.with({ path: `${parentPath}/${fileName}` });
}

/** Remove a task by id from another board file (used to undo archive/restore). */
async function removeTaskFromBoardFile(uri: vscode.Uri, taskId: string): Promise<void> {
  let board: KanbanBoard;
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    board = parseMarkdown(Buffer.from(data).toString('utf-8'));
  } catch {
    return;
  }

  let removed = false;
  for (const column of board.columns) {
    const index = column.tasks.findIndex(task => task.id === taskId);
    if (index !== -1) {
      column.tasks.splice(index, 1);
      removed = true;
      break;
    }
  }

  if (removed) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeToMarkdown(board), 'utf-8'));
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openExternalLink(url: unknown): Promise<void> {
  if (typeof url !== 'string' || !url.trim()) {
    return;
  }

  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(url.trim(), true);
  } catch {
    vscode.window.showWarningMessage(`リンクを解析できませんでした: ${url}`);
    return;
  }

  // Task text can come from shared board files, so only follow web links.
  if (uri.scheme !== 'http' && uri.scheme !== 'https') {
    vscode.window.showWarningMessage(`このリンクは開けません: ${url}`);
    return;
  }

  await vscode.env.openExternal(uri);
}
