import * as vscode from 'vscode';
import { archiveTaskFromBoard } from './archive';
import {
  parseMarkdown,
  serializeToMarkdown,
  KanbanBoard,
  KanbanColumn,
  KanbanTask,
  ColumnSort,
  COLUMN_SORT_VALUES,
  Repeat,
  REPEAT_VALUES,
  generateId,
} from './kanbanParser';
import { openLinkedFile, openTaskSource } from './source';
import { getWebviewContent } from './webviewContent';

/**
 * One undoable step: the board as it was before the change, plus an optional
 * task to delete from another board file (archive/restore write two files).
 */
interface UndoEntry {
  board: KanbanBoard;
  cleanup?: { uri: vscode.Uri; taskIds: string[] };
}

/** What the webview shows about a task's details file without opening it. */
interface DetailsInfo {
  /** First lines of the file below its heading ('' when nothing is written yet). */
  preview: string;
  /** Last modification time (ms since epoch). */
  mtime: number;
}

const MAX_UNDO_STEPS = 50;
const DETAILS_PREVIEW_CHARS = 300;

export class KanbanPanel {
  public static readonly viewType = 'mdKanbanJp.boardView';
  private static panels: Map<string, KanbanPanel> = new Map();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _fileUri: vscode.Uri;
  private _board: KanbanBoard;
  private _undoStack: UndoEntry[] = [];
  private _lastSavedContent?: string;
  private _rendered = false;
  private readonly _creatingDetailsFor = new Set<string>();
  private _detailsRefreshTimer?: ReturnType<typeof setTimeout>;
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

    // Details files are edited in normal editors; keep previews and
    // "updated N days ago" labels current while the board is open.
    if (!isArchiveBoardFile(fileUri)) {
      const boardDir = fileUri.with({ path: fileUri.path.replace(/\/[^/]*$/, '') || '/' });
      const folderName = getTaskDetailsFolderName(getFileName(fileUri));
      const detailsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(boardDir, `${folderName}/*.md`)
      );
      const schedule = () => this._scheduleDetailsInfoUpdate();
      detailsWatcher.onDidChange(schedule);
      detailsWatcher.onDidCreate(schedule);
      detailsWatcher.onDidDelete(schedule);
      this._disposables.push(detailsWatcher);
    }

    this._loadAndRefresh();
  }

  private async _loadAndRefresh() {
    let content: string | undefined;
    try {
      const data = await vscode.workspace.fs.readFile(this._fileUri);
      content = Buffer.from(data).toString('utf-8');
      this._board = parseMarkdown(content);
      // Hand-edited files may be out of order; show them by their sort rule.
      applyColumnSorts(this._board);
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

    // The file watcher also fires for our own saves. Rebuilding the HTML then
    // would reload the webview and discard transient UI state (quick-add
    // input, keyboard focus, notices), so only rebuild for outside changes.
    if (this._rendered && content !== undefined && content === this._lastSavedContent) {
      return;
    }

    const detailsInfo = await this._collectDetailsInfo();
    try {
      this._panel.webview.html = getWebviewContent(
        this._panel.webview,
        this._extensionUri,
        this._board,
        {
          canArchiveCards: !isArchiveBoardFile(this._fileUri),
          isArchiveBoard: isArchiveBoardFile(this._fileUri),
          canUndo: this._undoStack.length > 0,
          detailsInfo,
          completedColumnGlobs: getCompletedColumnGlobs(),
        }
      );
      this._rendered = true;
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
    // Columns with a sort rule keep that order through every change.
    applyColumnSorts(this._board);
    const md = serializeToMarkdown(this._board);
    // Remembered so the watcher can tell our own writes from outside edits.
    this._lastSavedContent = md;
    await vscode.workspace.fs.writeFile(this._fileUri, Buffer.from(md, 'utf-8'));
  }

  private async _handleMessage(message: { type: string; [key: string]: any }) {
    // Structural fields land on single markdown lines (# / ## / ### / #### / <!-- -->);
    // strip newlines so webview input cannot inject headings into the board file.
    for (const key of ['title', 'name', 'oldName', 'newName', 'column', 'fromColumn', 'toColumn', 'group', 'assignee', 'source', 'dueDate', 'startDate', 'tag']) {
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
          const id = generateId();
          const detailsFile = await this._createTaskDetailsFile(id, message.title);
          col.tasks.push({
            id,
            title: message.title,
            description: message.description || '',
            tags: message.tags || [],
            priority: message.priority || 'medium',
            workload: message.workload || 'normal',
            dueDate: message.dueDate || '',
            // New cards record when the work started unless one was given.
            startDate: normalizeDate(message.startDate) || toDateIso(startOfToday()),
            subtasks: message.subtasks || [],
            assignee: message.assignee || '',
            source: message.source || '',
            group: message.group || '',
            repeat: normalizeRepeat(message.repeat),
            detailsFile,
            doneDate: isCompletedColumnName(col.name, getCompletedColumnGlobs())
              ? toDateIso(startOfToday())
              : undefined,
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
            task.startDate = normalizeDate(message.startDate);
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

      case 'createTaskDetailsFile': {
        // Paths that change nothing leave the board as is, so the generic
        // no-op check after this switch discards their undo snapshot.
        if (isArchiveBoardFile(this._fileUri)) {
          this._notify('アーカイブボード内のカードには詳細ファイルを作成できません。', false);
          break;
        }

        let target: KanbanTask | undefined;
        for (const col of this._board.columns) {
          target = col.tasks.find(t => t.id === message.taskId);
          if (target) break;
        }

        if (!target || this._creatingDetailsFor.has(target.id)) {
          // Missing task, or a repeated click while the first is in flight.
          break;
        }
        if (target.detailsFile) {
          this._notify('このタスクには既に詳細ファイルがあります。', false);
          break;
        }

        this._creatingDetailsFor.add(target.id);
        try {
          const detailsFile = await this._createTaskDetailsFile(target.id, target.title);
          if (detailsFile) {
            target.detailsFile = detailsFile;
            await this._save();
            this._sendBoardUpdate();
            this._notify('詳細ファイルを作成しました。');
            await openLinkedFile(detailsFile, this._fileUri);
          }
        } finally {
          this._creatingDetailsFor.delete(target.id);
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
            const [removed] = col.tasks.splice(idx, 1);
            await this._save();
            this._sendBoardUpdate();
            if (message.deleteDetailsFile === true) {
              await this._trashDetailsFiles([removed]);
            }
            break;
          }
        }
        break;
      }

      case 'duplicateTask': {
        await this._duplicateTask(message.taskId);
        break;
      }

      case 'bulkMove': {
        const toCol = this._board.columns.find(c => c.name === message.toColumn);
        const ids = toIdList(message.taskIds);
        if (!toCol || ids.length === 0) {
          break;
        }
        let moved = 0;
        for (const id of ids) {
          const fromCol = this._board.columns.find(c => c.tasks.some(t => t.id === id));
          if (!fromCol || fromCol === toCol) {
            continue;
          }
          const taskIdx = fromCol.tasks.findIndex(t => t.id === id);
          const [task] = fromCol.tasks.splice(taskIdx, 1);
          const previousGroup = task.group;
          task.group = '';
          toCol.tasks.push(task);
          updateDoneDate(task, fromCol, toCol);
          this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx, previousGroup);
          moved++;
        }
        if (moved > 0) {
          await this._save();
          this._sendBoardUpdate();
          this._notify(`${moved}件のカードを「${toCol.name}」に移動しました。`);
        }
        break;
      }

      case 'bulkAddTag': {
        const tag = typeof message.tag === 'string' ? message.tag.replace(/^#/, '').trim() : '';
        const ids = new Set(toIdList(message.taskIds));
        if (!tag || ids.size === 0) {
          break;
        }
        let changed = 0;
        for (const col of this._board.columns) {
          for (const task of col.tasks) {
            if (ids.has(task.id) && !task.tags.includes(tag)) {
              task.tags.push(tag);
              changed++;
            }
          }
        }
        if (changed > 0) {
          await this._save();
          this._sendBoardUpdate();
          this._notify(`${changed}件のカードにタグ「${tag}」を追加しました。`);
        } else {
          this._notify(`選択したカードにはすでにタグ「${tag}」が付いています。`);
        }
        break;
      }

      case 'bulkDelete': {
        const ids = new Set(toIdList(message.taskIds));
        const removed: KanbanTask[] = [];
        for (const col of this._board.columns) {
          col.tasks = col.tasks.filter(task => {
            if (ids.has(task.id)) {
              removed.push(task);
              return false;
            }
            return true;
          });
        }
        if (removed.length > 0) {
          await this._save();
          this._sendBoardUpdate();
          this._notify(`${removed.length}件のカードを削除しました。`);
          if (message.deleteDetailsFile === true) {
            await this._trashDetailsFiles(removed);
          }
        }
        break;
      }

      case 'bulkArchive': {
        await this._bulkArchive(toIdList(message.taskIds));
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
            updateDoneDate(task, fromCol, toCol);
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
            // The next occurrence stays in the original column, so it keeps
            // the group the card had before this move.
            const previousGroup = task.group;
            task.group = message.group ?? '';
            let insertIdx = this._getMoveInsertIndex(toCol, message, targetLength);
            toCol.tasks.splice(insertIdx, 0, task);
            updateDoneDate(task, fromCol, toCol);
            this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx, previousGroup);
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

      case 'openFile': {
        await openLinkedFile(message.path, this._fileUri);
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
              entry.cleanup = { uri: archived.archiveUri, taskIds: [archived.archivedTaskId] };
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
        const by = normalizeColumnSort(message.by);
        if (col && by) {
          // Once a column has a rule, choosing an order changes the rule
          // rather than sorting just once (a one-off would be undone on save).
          const persist = message.persist === true || col.sort !== undefined;
          if (persist) {
            col.sort = by;
          } else {
            col.tasks = sortColumnTasks(col.tasks, by);
          }
          await this._save();
          this._sendBoardUpdate();
          this._notify(
            persist
              ? `「${col.name}」を常に${sortLabel(by)}で並べ替えるようにしました。`
              : `「${col.name}」を${sortLabel(by)}で並べ替えました。`
          );
        }
        break;
      }

      case 'clearColumnSort': {
        const col = this._board.columns.find(c => c.name === message.name);
        if (col && col.sort) {
          delete col.sort;
          await this._save();
          this._sendBoardUpdate();
          this._notify(`「${col.name}」の自動並べ替えを解除しました。現在の並びは保持されます。`);
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
          await removeTasksFromBoardFile(entry.cleanup.uri, entry.cleanup.taskIds);
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

  /**
   * Create a dedicated Markdown file for a new task's ongoing notes, in a
   * folder named after the board file (e.g. `project.tasks/<id>.md` beside
   * `project.kanban.md`). Returns the path to store on the task (relative to
   * the board file), or undefined if the file could not be created.
   */
  private async _createTaskDetailsFile(taskId: string, title: unknown): Promise<string | undefined> {
    if (isArchiveBoardFile(this._fileUri)) {
      return undefined;
    }

    const folderName = getTaskDetailsFolderName(getFileName(this._fileUri));
    const folderUri = getSiblingUri(this._fileUri, folderName);
    const relativePath = `${folderName}/${taskId}.md`;
    const heading = typeof title === 'string' && title.trim() ? title.trim() : '無題のタスク';
    const fileUri = vscode.Uri.joinPath(folderUri, `${taskId}.md`);

    // The file can already exist, e.g. after undoing a link or deleting the
    // details comment by hand. Reuse it so the user's notes are never lost.
    try {
      await vscode.workspace.fs.stat(fileUri);
      return relativePath;
    } catch {
      // Not there yet; create it below.
    }

    try {
      await vscode.workspace.fs.createDirectory(folderUri);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(`# ${heading}\n`, 'utf-8'));
      return relativePath;
    } catch (error) {
      this._notify(`詳細ファイルを作成できませんでした: ${getErrorMessage(error)}`, false);
      return undefined;
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
    updateDoneDate(restored, undefined, targetColumn);

    this._pushUndo({ uri: targetUri, taskIds: [restored.id] });
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
    originalIndex: number,
    originalGroup: string = task.group
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
      group: originalGroup,
      doneDate: undefined,
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
    // Details files may have been linked, unlinked or created by this change.
    this._scheduleDetailsInfoUpdate();
  }

  private _scheduleDetailsInfoUpdate() {
    if (this._detailsRefreshTimer) {
      clearTimeout(this._detailsRefreshTimer);
    }
    this._detailsRefreshTimer = setTimeout(async () => {
      this._detailsRefreshTimer = undefined;
      const info = await this._collectDetailsInfo();
      this._panel.webview.postMessage({ type: 'detailsInfo', info });
    }, 200);
  }

  /** Resolve a task's details path, refusing anything outside the board's folder tree. */
  private _resolveDetailsUri(relativePath: string | undefined): vscode.Uri | undefined {
    if (!relativePath || /^[a-z][a-z0-9+.-]*:/i.test(relativePath) || relativePath.startsWith('/')) {
      return undefined;
    }
    const boardDir = this._fileUri.with({ path: this._fileUri.path.replace(/\/[^/]*$/, '') || '/' });
    return vscode.Uri.joinPath(boardDir, relativePath.replace(/:\d+$/, ''));
  }

  /** Read a short preview and the modification time of each linked details file. */
  private async _collectDetailsInfo(): Promise<Record<string, DetailsInfo>> {
    const info: Record<string, DetailsInfo> = {};
    const tasks = this._board.columns.flatMap(column => column.tasks).filter(task => task.detailsFile);
    await Promise.all(tasks.map(async task => {
      const uri = this._resolveDetailsUri(task.detailsFile);
      if (!uri) {
        return;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const data = await vscode.workspace.fs.readFile(uri);
        info[task.id] = {
          preview: makeDetailsPreview(Buffer.from(data).toString('utf-8')),
          mtime: stat.mtime,
        };
      } catch {
        // Missing files simply have no preview.
      }
    }));
    return info;
  }

  /**
   * Move deleted cards' details files to the trash. Only files inside this
   * board's own `<board>.tasks/` folder are touched, never arbitrary links.
   */
  private async _trashDetailsFiles(tasks: KanbanTask[]): Promise<void> {
    const folderName = getTaskDetailsFolderName(getFileName(this._fileUri));
    const folderUri = getSiblingUri(this._fileUri, folderName);
    let trashed = 0;
    const failures: string[] = [];
    for (const task of tasks) {
      const uri = this._resolveDetailsUri(task.detailsFile);
      if (!uri || !uri.path.startsWith(`${folderUri.path}/`) || uri.path.slice(folderUri.path.length + 1).includes('/')) {
        continue;
      }
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        trashed++;
      } catch (error) {
        failures.push(`${task.detailsFile}: ${getErrorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      this._notify(`詳細ファイルを削除できませんでした: ${failures.join(', ')}`, false);
    } else if (trashed > 0) {
      this._notify(`詳細ファイル${trashed}件をゴミ箱に移動しました。`);
    }
  }

  /** Copy a card next to the original with a fresh id and its own details file. */
  private async _duplicateTask(taskId: unknown): Promise<void> {
    if (typeof taskId !== 'string') {
      return;
    }
    for (const col of this._board.columns) {
      const idx = col.tasks.findIndex(t => t.id === taskId);
      if (idx === -1) {
        continue;
      }
      const original = col.tasks[idx];
      const id = generateId();
      const title = `${original.title} のコピー`;
      const copy: KanbanTask = {
        ...original,
        id,
        title,
        tags: [...original.tags],
        subtasks: original.subtasks.map(subtask => ({ ...subtask, done: false })),
        startDate: toDateIso(startOfToday()),
        doneDate: isCompletedColumnName(col.name, getCompletedColumnGlobs()) ? toDateIso(startOfToday()) : undefined,
        archivedFrom: undefined,
        detailsFile: undefined,
      };
      if (original.detailsFile) {
        copy.detailsFile = await this._createTaskDetailsFile(id, title);
      }
      col.tasks.splice(idx + 1, 0, copy);
      await this._save();
      this._sendBoardUpdate();
      this._panel.webview.postMessage({ type: 'openTaskEditor', taskId: id });
      this._notify(`「${original.title}」を複製しました。`);
      return;
    }
  }

  /** Archive several cards; one undo step removes them all from the archive again. */
  private async _bulkArchive(ids: string[]): Promise<void> {
    if (isArchiveBoardFile(this._fileUri)) {
      this._notify('archive.kanban.md内のカードは再度アーカイブできません。', false);
      return;
    }
    if (ids.length === 0) {
      return;
    }

    this._pushUndo();
    const entry = this._undoStack[this._undoStack.length - 1];
    const archivedIds: string[] = [];
    let archiveUri: vscode.Uri | undefined;
    let errorText: string | undefined;
    for (const id of ids) {
      try {
        const archived = await archiveTaskFromBoard(this._board, this._fileUri, {
          taskId: id,
          taskSnapshot: undefined,
          fromColumn: undefined,
          taskIndex: undefined,
        });
        if (archived) {
          archiveUri = archived.archiveUri;
          archivedIds.push(archived.archivedTaskId);
        }
      } catch (error) {
        errorText = getErrorMessage(error);
        break;
      }
    }

    if (archivedIds.length === 0 || !archiveUri) {
      if (entry && this._undoStack[this._undoStack.length - 1] === entry) {
        this._undoStack.pop();
      }
      this._notify(errorText ? `カードをアーカイブできませんでした: ${errorText}` : 'カードが見つかりませんでした。', false);
      return;
    }

    if (entry) {
      entry.cleanup = { uri: archiveUri, taskIds: archivedIds };
    }
    await this._save();
    await vscode.commands.executeCommand('md-kanban-jp.refreshBoards').then(undefined, () => undefined);
    this._sendBoardUpdate();
    this._notify(
      errorText
        ? `${archivedIds.length}件をアーカイブしましたが、残りは失敗しました: ${errorText}`
        : `${archivedIds.length}件のカードをarchive.kanban.mdにアーカイブしました。`,
      !errorText
    );
  }

  private _notify(message: string, ok = true) {
    this._panel.webview.postMessage({ type: 'notice', message, ok });
  }

  /** Snapshot the board before a change so it can be undone. */
  private _pushUndo(cleanup?: UndoEntry['cleanup']) {
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
    if (this._detailsRefreshTimer) {
      clearTimeout(this._detailsRefreshTimer);
      this._detailsRefreshTimer = undefined;
    }
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
  'clearColumnSort',
  'createTaskDetailsFile',
  'duplicateTask',
  'bulkMove',
  'bulkAddTag',
  'bulkDelete',
]);

function toIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Record when a card reaches a completed-style column and forget it when the
 * card moves back. Moves between completed columns (and restores) keep the date.
 */
function updateDoneDate(task: KanbanTask, fromColumn: KanbanColumn | undefined, toColumn: KanbanColumn): void {
  const globs = getCompletedColumnGlobs();
  if (!isCompletedColumnName(toColumn.name, globs)) {
    delete task.doneDate;
  } else if (fromColumn && !isCompletedColumnName(fromColumn.name, globs)) {
    task.doneDate = toDateIso(startOfToday());
  }
}

/** Body text of a details file below its first heading, shortened for a tooltip. */
function makeDetailsPreview(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && !lines[start].trim()) {
    start++;
  }
  if (start < lines.length && /^#\s/.test(lines[start])) {
    start++;
  }
  const body = lines.slice(start).join('\n').trim();
  return body.length > DETAILS_PREVIEW_CHARS ? `${body.slice(0, DETAILS_PREVIEW_CHARS)}…` : body;
}

function cloneBoard(board: KanbanBoard): KanbanBoard {
  return JSON.parse(JSON.stringify(board)) as KanbanBoard;
}

function normalizeDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : '';
}

function toDateIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
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

function normalizeColumnSort(value: unknown): ColumnSort | undefined {
  return typeof value === 'string' && (COLUMN_SORT_VALUES as string[]).includes(value)
    ? (value as ColumnSort)
    : undefined;
}

/** Re-sort every column that carries a persistent sort rule. */
function applyColumnSorts(board: KanbanBoard): void {
  for (const column of board.columns) {
    if (column.sort) {
      column.tasks = sortColumnTasks(column.tasks, column.sort);
    }
  }
}

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

function getFileName(uri: vscode.Uri): string {
  return uri.path.split('/').pop() || 'kanban.md';
}

/** `project.kanban.md` -> `project.tasks`; `kanban.md` / `.kanban.md` -> `kanban.tasks` / `.kanban.tasks`. */
function getTaskDetailsFolderName(boardFileName: string): string {
  if (/^\.?kanban\.md$/i.test(boardFileName)) {
    return boardFileName.startsWith('.') ? '.kanban.tasks' : 'kanban.tasks';
  }
  return boardFileName.replace(/\.kanban\.md$/i, '.tasks');
}

/** Remove tasks by id from another board file (used to undo archive/restore). */
async function removeTasksFromBoardFile(uri: vscode.Uri, taskIds: string[]): Promise<void> {
  let board: KanbanBoard;
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    board = parseMarkdown(Buffer.from(data).toString('utf-8'));
  } catch {
    return;
  }

  const ids = new Set(taskIds);
  let removed = false;
  for (const column of board.columns) {
    const before = column.tasks.length;
    column.tasks = column.tasks.filter(task => !ids.has(task.id));
    removed = removed || column.tasks.length !== before;
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
