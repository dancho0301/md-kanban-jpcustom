import * as vscode from 'vscode';
import { parseMarkdown, serializeToMarkdown, KanbanBoard, KanbanTask } from './kanbanParser';

export interface ArchiveTaskRequest {
  taskId: unknown;
  taskSnapshot: unknown;
  fromColumn: unknown;
  taskIndex: unknown;
}

export interface ArchiveTaskResult {
  archiveColumnName: string;
}

export async function archiveTaskFromBoard(
  board: KanbanBoard,
  sourceUri: vscode.Uri,
  request: ArchiveTaskRequest
): Promise<ArchiveTaskResult | undefined> {
  const taskLocation = findTaskForArchive(board, request);
  if (!taskLocation) {
    return undefined;
  }

  const [task] = taskLocation.column.tasks.splice(taskLocation.taskIndex, 1);
  const archiveUri = getSiblingUri(sourceUri, 'archive.kanban.md');
  const archiveBoard = await readArchiveBoard(archiveUri);
  const archiveColumnName = getBoardFileName(sourceUri);
  const archiveColumn = getOrCreateArchiveColumn(archiveBoard, archiveColumnName);
  archiveColumn.tasks.push(cloneTask(task));

  await vscode.workspace.fs.writeFile(archiveUri, Buffer.from(serializeToMarkdown(archiveBoard), 'utf-8'));
  return { archiveColumnName };
}

async function readArchiveBoard(archiveUri: vscode.Uri): Promise<KanbanBoard> {
  try {
    const data = await vscode.workspace.fs.readFile(archiveUri);
    return parseMarkdown(Buffer.from(data).toString('utf-8'));
  } catch {
    return {
      title: 'Archive Board',
      columns: [],
    };
  }
}

function findTaskForArchive(
  board: KanbanBoard,
  request: ArchiveTaskRequest
): { column: KanbanBoard['columns'][number]; taskIndex: number } | undefined {
  if (typeof request.taskId === 'string') {
    for (const column of board.columns) {
      const taskIndex = column.tasks.findIndex(task => task.id === request.taskId);
      if (taskIndex !== -1) {
        return { column, taskIndex };
      }
    }
  }

  if (!isTaskSnapshot(request.taskSnapshot)) {
    return undefined;
  }
  const taskSnapshot = request.taskSnapshot;

  const preferredColumn = typeof request.fromColumn === 'string'
    ? board.columns.find(column => column.name === request.fromColumn)
    : undefined;

  if (preferredColumn && typeof request.taskIndex === 'number' && Number.isInteger(request.taskIndex)) {
    const indexedTask = preferredColumn.tasks[request.taskIndex];
    if (indexedTask && tasksMatch(indexedTask, taskSnapshot)) {
      return { column: preferredColumn, taskIndex: request.taskIndex };
    }
  }

  const columns = preferredColumn
    ? [preferredColumn, ...board.columns.filter(column => column !== preferredColumn)]
    : board.columns;

  for (const column of columns) {
    const taskIndex = column.tasks.findIndex(task => tasksMatch(task, taskSnapshot));
    if (taskIndex !== -1) {
      return { column, taskIndex };
    }
  }

  return undefined;
}

function getOrCreateArchiveColumn(board: KanbanBoard, columnName: string) {
  let archiveColumn = board.columns.find(column => column.name === columnName);
  if (!archiveColumn) {
    archiveColumn = { name: columnName, tasks: [] };
    board.columns.push(archiveColumn);
  }
  return archiveColumn;
}

function getBoardFileName(uri: vscode.Uri): string {
  return uri.path.split('/').pop() || 'Archived';
}

function getSiblingUri(uri: vscode.Uri, fileName: string): vscode.Uri {
  const parentPath = uri.path.replace(/\/[^/]*$/, '');
  return uri.with({ path: `${parentPath}/${fileName}` });
}

function cloneTask(task: KanbanTask): KanbanTask {
  return {
    ...task,
    subtasks: task.subtasks.map(subtask => ({ ...subtask })),
    tags: [...task.tags],
  };
}

function isTaskSnapshot(value: unknown): value is Partial<KanbanTask> {
  return !!value && typeof value === 'object' && typeof (value as Partial<KanbanTask>).title === 'string';
}

function tasksMatch(task: KanbanTask, snapshot: Partial<KanbanTask>): boolean {
  return task.title === snapshot.title
    && task.description === (snapshot.description || '')
    && task.priority === (snapshot.priority || 'medium')
    && task.workload === (snapshot.workload || 'normal')
    && task.dueDate === (snapshot.dueDate || '')
    && task.assignee === (snapshot.assignee || '')
    && task.source === (snapshot.source || '')
    && task.group === (snapshot.group || '')
    && stringArraysEqual(task.tags, snapshot.tags || [])
    && subtasksEqual(task.subtasks, snapshot.subtasks || []);
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function subtasksEqual(left: KanbanTask['subtasks'], right: KanbanTask['subtasks']): boolean {
  return left.length === right.length
    && left.every((subtask, index) =>
      subtask.title === right[index]?.title && subtask.done === right[index]?.done
    );
}
