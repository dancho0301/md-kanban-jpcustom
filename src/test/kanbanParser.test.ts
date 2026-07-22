import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdown,
  serializeToMarkdown,
  createBoardFromTemplate,
  BOARD_TEMPLATES,
  KanbanBoard,
} from '../kanbanParser';

const SAMPLE = `# マイボード

## 未着手

#### データベース設定
<!-- id: task-1 -->
マイグレーションを整える。
- [x] スキーマ設計
- [ ] ファイル作成
Tags: \`backend\` \`db\`
<!-- priority: high -->
<!-- workload: hard -->
<!-- due: 2026-04-01 -->
<!-- assignee: 田中 -->
<!-- source: src/db.ts:42 -->

### 認証

#### ログイン実装
<!-- id: task-2 -->
Tags: \`feature\`
<!-- priority: critical -->

## 完了

#### 初期調査
<!-- id: task-3 -->
`;

test('parseMarkdown reads title, columns, groups, and task fields', () => {
  const board = parseMarkdown(SAMPLE);

  assert.equal(board.title, 'マイボード');
  assert.equal(board.columns.length, 2);
  assert.equal(board.columns[0].name, '未着手');
  assert.equal(board.columns[1].name, '完了');

  const dbTask = board.columns[0].tasks.find(t => t.id === 'task-1');
  assert.ok(dbTask);
  assert.equal(dbTask!.title, 'データベース設定');
  assert.equal(dbTask!.description, 'マイグレーションを整える。');
  assert.equal(dbTask!.priority, 'high');
  assert.equal(dbTask!.workload, 'hard');
  assert.equal(dbTask!.dueDate, '2026-04-01');
  assert.equal(dbTask!.assignee, '田中');
  assert.equal(dbTask!.source, 'src/db.ts:42');
  assert.deepEqual(dbTask!.tags, ['backend', 'db']);
  assert.deepEqual(dbTask!.subtasks, [
    { title: 'スキーマ設計', done: true },
    { title: 'ファイル作成', done: false },
  ]);

  const loginTask = board.columns[0].tasks.find(t => t.id === 'task-2');
  assert.ok(loginTask);
  assert.equal(loginTask!.group, '認証');
  assert.equal(loginTask!.priority, 'critical');
});

test('serialize then parse round-trips the board structure', () => {
  const original = parseMarkdown(SAMPLE);
  const reparsed = parseMarkdown(serializeToMarkdown(original));
  assert.deepEqual(normalize(reparsed), normalize(original));
});

test('empty board with marker stays empty; without marker gets default columns', () => {
  const emptyWithMarker = parseMarkdown('<!-- empty-board: true -->\n# 空\n');
  assert.equal(emptyWithMarker.columns.length, 0);

  const emptyNoMarker = parseMarkdown('# 空\n');
  assert.deepEqual(emptyNoMarker.columns.map(c => c.name), ['未着手', '進行中', '完了']);
});

test('default priority/workload are omitted from serialized output', () => {
  const board: KanbanBoard = {
    title: 'T',
    columns: [{ name: 'C', tasks: [{
      id: 'x', title: 'デフォルト', description: '', tags: [],
      priority: 'medium', workload: 'normal', dueDate: '',
      subtasks: [], assignee: '', source: '', group: '',
    }] }],
  };
  const md = serializeToMarkdown(board);
  assert.ok(!md.includes('<!-- priority:'));
  assert.ok(!md.includes('<!-- workload:'));
});

test('createBoardFromTemplate uses the template columns', () => {
  for (const template of BOARD_TEMPLATES) {
    const md = createBoardFromTemplate('テスト', template.id);
    const board = parseMarkdown(md);
    if (template.columns.length === 0) {
      // Blank template opts out of default columns via the empty-board marker.
      assert.equal(board.columns.length, 0);
    } else {
      assert.deepEqual(board.columns.map(c => c.name), template.columns);
    }
  }
});

function normalize(board: KanbanBoard) {
  return {
    title: board.title,
    columns: board.columns.map(column => ({
      name: column.name,
      tasks: column.tasks.map(task => ({ ...task })),
    })),
  };
}
