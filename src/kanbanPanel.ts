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
import {
  buildDetailsFileContent,
  ensureKanbanId,
  makeDetailsPreview,
  readKanbanId,
  relativePath,
  stripCopySuffix,
  toNoteFileBaseName,
} from './detailsFiles';
import { openLinkedFile, openTaskSource } from './source';

const DETAILS_PREVIEW_CHARS = 300;
import { getWebviewContent } from './webviewContent';

/**
 * One undoable step: the board as it was before the change, plus an optional
 * task to delete from another board file (archive/restore write two files).
 */
interface UndoEntry {
  board: KanbanBoard;
  cleanup?: { uri: vscode.Uri; taskIds: string[] };
  /** Details files renamed/moved by the change, moved back on undo. */
  fileMoves?: FileMove[];
}

interface FileMove {
  from: vscode.Uri;
  to: vscode.Uri;
}

/** What the webview shows about a task's details file without opening it. */
interface DetailsInfo {
  /** First lines of the file below its heading ('' when nothing is written yet). */
  preview: string;
  /** Last modification time (ms since epoch). */
  mtime: number;
}

const MAX_UNDO_STEPS = 50;

export class KanbanPanel {
  public static readonly viewType = 'mdKanbanJp.boardView';
  private static panels: Map<string, KanbanPanel> = new Map();
  private static lastActive?: KanbanPanel;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _fileUri: vscode.Uri;
  private _board: KanbanBoard;
  private _undoStack: UndoEntry[] = [];
  private _lastSavedContent?: string;
  private _rendered = false;
  private readonly _creatingDetailsFor = new Set<string>();
  private _detailsRefreshTimer?: ReturnType<typeof setTimeout>;
  /** Missing details paths already searched for, so a lost file is not rescanned on every refresh. */
  private readonly _relinkTried = new Set<string>();
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
    KanbanPanel.lastActive = this;
    this._panel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        KanbanPanel.lastActive = this;
      }
    }, null, this._disposables);

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
      // A file appearing (e.g. moved back by hand) is worth another search.
      const scheduleAfterCreate = () => {
        this._relinkTried.clear();
        schedule();
      };
      detailsWatcher.onDidChange(schedule);
      detailsWatcher.onDidCreate(scheduleAfterCreate);
      detailsWatcher.onDidDelete(schedule);
      this._disposables.push(detailsWatcher);

      const completedFolder = getCompletedDetailsFolderUri(fileUri);
      if (completedFolder) {
        const completedWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(completedFolder, '*.md')
        );
        completedWatcher.onDidChange(schedule);
        completedWatcher.onDidCreate(scheduleAfterCreate);
        completedWatcher.onDidDelete(schedule);
        this._disposables.push(completedWatcher);
      }
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
          const detailsFile = await this._createTaskDetailsFile(id, message.title, message.tags);
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
            const previousTitle = task.title;
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
            if (task.detailsFile && previousTitle !== task.title) {
              // Keep the notes file named after the task (Foam-style notes).
              const move = await this._renameDetailsFileForTitle(task, previousTitle);
              if (move) {
                this._recordFileMoves([move]);
              }
            }
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
          const detailsFile = await this._createTaskDetailsFile(target.id, target.title, target.tags);
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
        const completedTasks: KanbanTask[] = [];
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
          if (updateDoneDate(task, fromCol, toCol)) {
            completedTasks.push(task);
          }
          this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx, previousGroup);
          moved++;
        }
        if (completedTasks.length > 0) {
          await this._fileCompletedDetails(completedTasks);
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
            const completed = updateDoneDate(task, fromCol, toCol);
            this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx);
            if (completed) {
              await this._fileCompletedDetails([task]);
            }
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
            const completed = updateDoneDate(task, fromCol, toCol);
            this._spawnRepeatOccurrence(task, fromCol, toCol, taskIdx, previousGroup);
            if (completed) {
              await this._fileCompletedDetails([task]);
            }
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
        let target = message.path;
        // A details file moved or renamed outside the extension is looked up
        // by the task id in its front matter before giving up.
        const linked = this._board.columns
          .flatMap(column => column.tasks)
          .filter(task => task.detailsFile && task.detailsFile === target);
        if (linked.length > 0 && !(await uriExists(this._resolveDetailsUri(target)))) {
          if (await this._relinkMissingDetails(linked, true)) {
            target = linked[0].detailsFile;
          }
        }
        await openLinkedFile(target, this._fileUri);
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
        if (entry.fileMoves) {
          await this._revertFileMoves(entry.fileMoves);
        }
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
      if (entry && !entry.cleanup && !entry.fileMoves && JSON.stringify(entry.board) === JSON.stringify(this._board)) {
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
  private async _createTaskDetailsFile(taskId: string, title: unknown, tags?: unknown): Promise<string | undefined> {
    if (isArchiveBoardFile(this._fileUri)) {
      return undefined;
    }

    const folderName = getTaskDetailsFolderName(getFileName(this._fileUri));
    const folderUri = getSiblingUri(this._fileUri, folderName);
    const heading = typeof title === 'string' && title.trim() ? title.trim() : '無題のタスク';

    try {
      await vscode.workspace.fs.createDirectory(folderUri);
      // Named after the task like a Foam note. An existing file is never
      // overwritten; a free "Name (2).md"-style name is used instead.
      const fileUri = await findFreeFileUri(folderUri, toNoteFileBaseName(heading));
      const content = buildDetailsFileContent({
        taskId,
        heading,
        tags,
        boardFileName: getFileName(this._fileUri),
        created: toDateIso(startOfToday()),
        frontmatter: vscode.workspace.getConfiguration('mdKanbanJp').get<boolean>('detailsFrontmatter', true) !== false,
      });
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
      return relativePathFrom(getParentUri(this._fileUri), fileUri);
    } catch (error) {
      this._notify(`詳細ファイルを作成できませんでした: ${getErrorMessage(error)}`, false);
      return undefined;
    }
  }

  /**
   * Rename a details file after its task's title changed. Only files still
   * named after the old title (or the old task-id scheme) follow, so names the
   * user chose by hand are left alone. Done through a workspace edit so
   * extensions such as Foam can update links to the file.
   */
  private async _renameDetailsFileForTitle(task: KanbanTask, previousTitle: string): Promise<FileMove | undefined> {
    const from = this._resolveDetailsUri(task.detailsFile);
    if (!from) {
      return undefined;
    }
    const currentBase = getFileName(from).replace(/\.md$/i, '');
    const followsTitle =
      currentBase === task.id ||
      stripCopySuffix(currentBase) === toNoteFileBaseName(previousTitle || '無題のタスク');
    if (!followsTitle) {
      return undefined;
    }
    const move = await this._moveDetailsFile(task, from, getParentUri(from), toNoteFileBaseName(task.title));
    if (move === null) {
      this._notify('詳細ファイルの名前を変更できませんでした。', false);
    }
    return move ?? undefined;
  }

  /** Move finished tasks' notes into the configured knowledge folder. */
  private async _fileCompletedDetails(tasks: KanbanTask[]): Promise<void> {
    const targetFolder = getCompletedDetailsFolderUri(this._fileUri);
    if (!targetFolder || isArchiveBoardFile(this._fileUri)) {
      return;
    }
    const moves: FileMove[] = [];
    let failed = 0;
    for (const task of tasks) {
      const from = this._resolveDetailsUri(task.detailsFile);
      if (!from || getParentUri(from).path === targetFolder.path) {
        continue;
      }
      const move = await this._moveDetailsFile(task, from, targetFolder, getFileName(from).replace(/\.md$/i, ''));
      if (move) {
        moves.push(move);
      } else if (move === null) {
        failed++;
      }
    }
    if (moves.length > 0) {
      this._recordFileMoves(moves);
      this._notify(`詳細ファイル${moves.length}件をナレッジフォルダ(${vscode.workspace.asRelativePath(targetFolder)})へ移動しました。`);
    }
    if (failed > 0) {
      this._notify(`詳細ファイル${failed}件をナレッジフォルダへ移動できませんでした。`, false);
    }
  }

  /**
   * Move/rename one details file and point the task at its new path.
   * Returns undefined when there is nothing to do and null on failure.
   */
  private async _moveDetailsFile(
    task: KanbanTask,
    from: vscode.Uri,
    targetFolder: vscode.Uri,
    baseName: string
  ): Promise<FileMove | null | undefined> {
    try {
      await vscode.workspace.fs.stat(from);
    } catch {
      return undefined;
    }
    try {
      await vscode.workspace.fs.createDirectory(targetFolder);
      const to = await findFreeFileUri(targetFolder, baseName, from);
      if (to.path === from.path) {
        return undefined;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(from, to, { overwrite: false });
      if (!(await vscode.workspace.applyEdit(edit))) {
        return null;
      }
      // Other cards can share the file (e.g. a repeating task's next
      // occurrence); keep all of their links pointing at it.
      const oldPath = task.detailsFile;
      const newPath = relativePathFrom(getParentUri(this._fileUri), to);
      for (const other of this._board.columns.flatMap(column => column.tasks)) {
        if (other === task || (oldPath && other.detailsFile === oldPath)) {
          other.detailsFile = newPath;
        }
      }
      return { from, to };
    } catch {
      return null;
    }
  }

  /** Attach file moves to the undo step of the change in progress. */
  private _recordFileMoves(moves: FileMove[]) {
    const entry = this._undoStack[this._undoStack.length - 1];
    if (entry) {
      entry.fileMoves = [...(entry.fileMoves ?? []), ...moves];
    }
  }

  private async _revertFileMoves(moves: FileMove[]): Promise<void> {
    let failed = 0;
    for (const move of [...moves].reverse()) {
      try {
        await vscode.workspace.fs.stat(move.to);
      } catch {
        continue;
      }
      try {
        await vscode.workspace.fs.stat(move.from);
        failed++;
        continue;
      } catch {
        // Original location is free; move it back.
      }
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(move.to, move.from, { overwrite: false });
      if (!(await vscode.workspace.applyEdit(edit).then(ok => ok, () => false))) {
        failed++;
      }
    }
    if (failed > 0) {
      this._notify(`詳細ファイル${failed}件を元の場所に戻せませんでした。`, false);
    }
  }

  /** Command: rename every details file of the most recently active board to its task title. */
  public static async renameDetailsFilesOfActiveBoard(): Promise<void> {
    const panel = KanbanPanel.lastActive;
    if (!panel || !KanbanPanel.panels.has(panel._fileUri.toString())) {
      vscode.window.showInformationMessage('先にカンバンボードを開いてから実行してください。');
      return;
    }
    await panel._renameAllDetailsFiles();
  }

  private async _renameAllDetailsFiles(): Promise<void> {
    if (isArchiveBoardFile(this._fileUri)) {
      vscode.window.showInformationMessage('アーカイブボードでは実行できません。');
      return;
    }
    const linked = this._board.columns.flatMap(column => column.tasks).filter(task => task.detailsFile);
    const candidates = linked.filter(task => {
      const uri = this._resolveDetailsUri(task.detailsFile);
      return !!uri && stripCopySuffix(getFileName(uri).replace(/\.md$/i, '')) !== toNoteFileBaseName(task.title);
    });
    const answer = await vscode.window.showInformationMessage(
      `「${this._board.title}」の詳細ファイルを整理しますか?`,
      {
        modal: true,
        detail:
          `・タスク名と違う名前のファイル ${candidates.length}件をタスク名に変更します(元に戻す で戻せます)。\n` +
          '・タスクIDが記録されていないファイルには、フロントマターに kanban-id を追記します(移動・リネームされても見つけ直せるようにするため)。',
      },
      '整理する'
    );
    if (answer !== '整理する') {
      return;
    }

    const stamped = await this._stampKanbanIds(linked);

    this._pushUndo();
    const moves: FileMove[] = [];
    let failed = 0;
    for (const task of candidates) {
      const from = this._resolveDetailsUri(task.detailsFile)!;
      const move = await this._moveDetailsFile(task, from, getParentUri(from), toNoteFileBaseName(task.title));
      if (move) {
        moves.push(move);
      } else if (move === null) {
        failed++;
      }
    }
    if (moves.length === 0) {
      this._undoStack.pop();
    } else {
      this._recordFileMoves(moves);
      await this._save();
      this._sendBoardUpdate();
    }
    this._notify(
      `${moves.length}件の名前をタスク名に変更し、${stamped}件にタスクIDを追記しました` +
        (failed > 0 ? `(${failed}件は名前を変更できませんでした)。` : '。'),
      failed === 0
    );
  }

  /** Record `kanban-id` in linked details files that lack one. Returns how many were updated. */
  private async _stampKanbanIds(tasks: KanbanTask[]): Promise<number> {
    const preferFrontmatter =
      vscode.workspace.getConfiguration('mdKanbanJp').get<boolean>('detailsFrontmatter', true) !== false;
    const done = new Set<string>();
    let stamped = 0;
    for (const task of tasks) {
      const uri = this._resolveDetailsUri(task.detailsFile);
      // Shared files keep the id of the first card that links them.
      if (!uri || done.has(uri.toString())) {
        continue;
      }
      done.add(uri.toString());
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        const updated = ensureKanbanId(content, task.id, preferFrontmatter);
        if (updated !== content) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));
          stamped++;
        }
      } catch {
        // Missing or read-only; leave it.
      }
    }
    return stamped;
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
    return vscode.Uri.joinPath(getParentUri(this._fileUri), relativePath.replace(/:\d+$/, ''));
  }

  /** Read a short preview and the modification time of each linked details file. */
  private async _collectDetailsInfo(): Promise<Record<string, DetailsInfo>> {
    const info: Record<string, DetailsInfo> = {};
    const tasks = this._board.columns.flatMap(column => column.tasks).filter(task => task.detailsFile);
    const missing: KanbanTask[] = [];
    await Promise.all(tasks.map(async task => {
      const uri = this._resolveDetailsUri(task.detailsFile);
      if (!uri) {
        return;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const data = await vscode.workspace.fs.readFile(uri);
        info[task.id] = {
          preview: makeDetailsPreview(Buffer.from(data).toString('utf-8'), DETAILS_PREVIEW_CHARS),
          mtime: stat.mtime,
        };
      } catch {
        missing.push(task);
      }
    }));

    // Cheap search in the known folders only; the whole workspace is searched
    // when the user actually opens a missing link.
    const untried = missing.filter(task => !this._relinkTried.has(task.detailsFile!));
    if (untried.length > 0 && !isArchiveBoardFile(this._fileUri)) {
      untried.forEach(task => this._relinkTried.add(task.detailsFile!));
      if (await this._relinkMissingDetails(untried, false)) {
        return this._collectDetailsInfo();
      }
    }
    return info;
  }

  /**
   * Find details files that are no longer at their recorded path by the
   * `kanban-id` they carry, and point the cards at the new location.
   * Cards sharing one path (repeat occurrences) move together.
   */
  private async _relinkMissingDetails(tasks: KanbanTask[], searchWorkspace: boolean): Promise<boolean> {
    const groups = new Map<string, KanbanTask[]>();
    for (const task of this._board.columns.flatMap(column => column.tasks)) {
      if (task.detailsFile && tasks.some(missing => missing.detailsFile === task.detailsFile)) {
        groups.set(task.detailsFile, [...(groups.get(task.detailsFile) ?? []), task]);
      }
    }
    const wanted = new Set([...groups.values()].flat().map(task => task.id));
    if (wanted.size === 0) {
      return false;
    }

    const found = await this._findDetailsFilesById(wanted, searchWorkspace);
    let relinked = 0;
    for (const [oldPath, group] of groups) {
      const uri = group.map(task => found.get(task.id)).find(Boolean);
      if (!uri) {
        continue;
      }
      const newPath = relativePathFrom(getParentUri(this._fileUri), uri);
      for (const task of group) {
        task.detailsFile = newPath;
      }
      this._relinkTried.delete(oldPath);
      relinked++;
    }
    if (relinked === 0) {
      return false;
    }
    await this._save();
    this._sendBoardUpdate();
    this._notify(`場所が変わっていた詳細ファイル${relinked}件を見つけ、リンクを更新しました。`);
    return true;
  }

  private async _findDetailsFilesById(ids: Set<string>, searchWorkspace: boolean): Promise<Map<string, vscode.Uri>> {
    const files: vscode.Uri[] = [];
    const folders = [
      getSiblingUri(this._fileUri, getTaskDetailsFolderName(getFileName(this._fileUri))),
      getCompletedDetailsFolderUri(this._fileUri),
    ].filter((uri): uri is vscode.Uri => !!uri);
    for (const folder of folders) {
      files.push(...await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.md'), undefined, 5000));
    }
    if (searchWorkspace) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._fileUri);
      if (workspaceFolder) {
        files.push(...await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceFolder, '**/*.md'),
          '{**/node_modules/**,**/.git/**}',
          20000
        ));
      }
    }

    const found = new Map<string, vscode.Uri>();
    const seen = new Set<string>();
    for (const file of files) {
      if (found.size === ids.size) {
        break;
      }
      if (seen.has(file.toString()) || /\.kanban\.md$|(^|\/)kanban\.md$/i.test(file.path)) {
        continue;
      }
      seen.add(file.toString());
      try {
        const data = await vscode.workspace.fs.readFile(file);
        const id = readKanbanId(Buffer.from(data).toString('utf-8'));
        if (id && ids.has(id) && !found.has(id)) {
          found.set(id, file);
        }
      } catch {
        // Unreadable file; skip.
      }
    }
    return found;
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
        copy.detailsFile = await this._createTaskDetailsFile(id, title, copy.tags);
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
function updateDoneDate(task: KanbanTask, fromColumn: KanbanColumn | undefined, toColumn: KanbanColumn): boolean {
  const globs = getCompletedColumnGlobs();
  if (!isCompletedColumnName(toColumn.name, globs)) {
    delete task.doneDate;
  } else if (fromColumn && !isCompletedColumnName(fromColumn.name, globs)) {
    task.doneDate = toDateIso(startOfToday());
    return true;
  }
  return false;
}

function getParentUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: uri.path.replace(/\/[^/]*$/, '') || '/' });
}

/** Workspace-relative knowledge folder from `mdKanbanJp.completedDetailsFolder`, if set. */
function getCompletedDetailsFolderUri(boardUri: vscode.Uri): vscode.Uri | undefined {
  const value = vscode.workspace.getConfiguration('mdKanbanJp').get<unknown>('completedDetailsFolder');
  const folder = typeof value === 'string' ? value.trim().replace(/^[/\\]+|[/\\]+$/g, '') : '';
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(boardUri);
  if (!folder || !workspaceFolder) {
    return undefined;
  }
  const segments = folder.split(/[/\\]/).filter(segment => segment && segment !== '.');
  // Stay inside the workspace.
  if (segments.includes('..')) {
    return undefined;
  }
  return vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
}

/** First unused `<base>.md`, `<base> (2).md`, ... in a folder. `self` counts as free. */
async function uriExists(uri: vscode.Uri | undefined): Promise<boolean> {
  if (!uri) {
    return false;
  }
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Path of `target` relative to the folder `baseDir`. */
function relativePathFrom(baseDir: vscode.Uri, target: vscode.Uri): string {
  return relativePath(baseDir.path, target.path);
}

async function findFreeFileUri(folder: vscode.Uri, baseName: string, self?: vscode.Uri): Promise<vscode.Uri> {
  for (let n = 1; n < 1000; n++) {
    const candidate = vscode.Uri.joinPath(folder, n === 1 ? `${baseName}.md` : `${baseName} (${n}).md`);
    if (self && candidate.path.toLowerCase() === self.path.toLowerCase()) {
      return self.path === candidate.path ? self : candidate;
    }
    try {
      await vscode.workspace.fs.stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('空いているファイル名が見つかりませんでした。');
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
