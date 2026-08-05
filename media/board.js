(function() {
  const vscode = acquireVsCodeApi();
  let board = JSON.parse(document.getElementById('board-data').textContent || '{"title":"カンバンボード","columns":[]}');
  const boardConfig = JSON.parse(document.getElementById('board-config')?.textContent || '{"canArchiveCards":true}');
  let dragData = null;
  let pendingFocusTaskId = null;
  let collapsedGroups = {};
  let expandedSubtasks = {};
  let quickAddColumn = null;
  let canUndo = boardConfig.canUndo === true;
  let filters = {
    text: '',
    assignee: '',
    tag: '',
    priority: '',
    workload: '',
    due: '',
  };
  let confirmationPrefs = {
    archiveCard: false,
    deleteTask: false,
    deleteColumn: false,
    deleteSubtask: false,
    restoreTask: false,
  };
  let textFilterTimer = 0;
  const taskTemplates = [
    {
      id: 'blank',
      label: '空白',
      title: '',
      description: '',
      tags: [],
      priority: 'medium',
      workload: 'normal',
      assignee: '',
      subtasks: [],
    },
    {
      id: 'meeting',
      label: '会議',
      title: '会議',
      description: '',
      tags: ['会議'],
      priority: 'medium',
      workload: 'easy',
      assignee: '',
      subtasks: [
        { title: 'アジェンダを準備する', done: false },
        { title: '議事録を取る', done: false },
        { title: '決定事項とToDoを共有する', done: false },
      ],
    },
    {
      id: 'project',
      label: 'プロジェクト',
      title: 'プロジェクト項目',
      description: '',
      tags: ['プロジェクト'],
      priority: 'medium',
      workload: 'hard',
      assignee: '',
      subtasks: [
        { title: 'ゴールを定義する', done: false },
        { title: '作業を分解する', done: false },
        { title: '期限と担当を決める', done: false },
      ],
    },
    {
      id: 'errand',
      label: '用事',
      title: '用事',
      description: '',
      tags: ['用事'],
      priority: 'medium',
      workload: 'easy',
      assignee: '',
      subtasks: [
        { title: '必要なものを準備する', done: false },
        { title: '実行する', done: false },
      ],
    },
    {
      id: 'personal',
      label: '個人',
      title: '個人タスク',
      description: '',
      tags: ['personal'],
      priority: 'medium',
      workload: 'easy',
      assignee: '',
      subtasks: [
        { title: '次のアクションを決める', done: false },
      ],
    },
  ];
  const savedState = vscode.getState();
  if (savedState && savedState.collapsedGroups) {
    collapsedGroups = savedState.collapsedGroups;
  }
  if (savedState && savedState.filters) {
    filters = { ...filters, ...savedState.filters };
  }
  if (savedState && savedState.confirmationPrefs) {
    confirmationPrefs = { ...confirmationPrefs, ...savedState.confirmationPrefs };
  }
  if (savedState && savedState.expandedSubtasks) {
    expandedSubtasks = savedState.expandedSubtasks;
  }
  if (savedState && savedState.quickAddColumn) {
    quickAddColumn = savedState.quickAddColumn;
  }
  if (savedState && savedState.pendingFocusTaskId) {
    pendingFocusTaskId = savedState.pendingFocusTaskId;
  }

  function render() {
    const app = document.getElementById('app');
    app.innerHTML = '';

    // Toolbar
    const toolbar = el('div', 'toolbar');
    const h1 = el('h1');
    h1.textContent = board.title;
    h1.title = 'クリックしてボード名を変更';
    h1.onclick = () => renameBoard();
    toolbar.appendChild(h1);

    const actions = el('div', 'toolbar-actions');

    const undoBtn = el('button', 'secondary');
    undoBtn.textContent = '↩ 元に戻す';
    undoBtn.title = '直前の操作を元に戻す (Ctrl+Z)';
    undoBtn.disabled = !canUndo;
    undoBtn.style.opacity = canUndo ? '' : '0.5';
    undoBtn.onclick = () => requestUndo();
    actions.appendChild(undoBtn);

    const mdBtn = el('button', 'secondary');
    mdBtn.textContent = '📄 Markdownを表示';
    mdBtn.onclick = () => vscode.postMessage({ type: 'openMarkdown' });
    actions.appendChild(mdBtn);
    const helpBtn = el('button', 'secondary');
    helpBtn.textContent = '⌨ ショートカット';
    helpBtn.title = 'キーボードショートカット (?)';
    helpBtn.onclick = () => openShortcutHelp();
    actions.appendChild(helpBtn);
    toolbar.appendChild(actions);
    app.appendChild(toolbar);
    app.appendChild(renderStatsBar());
    app.appendChild(renderFilterBar());

    // Board
    const boardEl = el('div', 'board');
    boardEl.addEventListener('dragover', (e) => {
      if (!dragData || dragData.type !== 'column') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      updateColumnDropIndicator(boardEl, e.clientX);
    });
    boardEl.addEventListener('dragleave', (e) => {
      if (!boardEl.contains(e.relatedTarget)) {
        removeColumnDropIndicator(boardEl);
      }
    });
    boardEl.addEventListener('drop', (e) => {
      if (!dragData || dragData.type !== 'column') return;
      e.preventDefault();
      const toIndex = getColumnDropIndex(boardEl, e.clientX);
      removeColumnDropIndicator(boardEl);
      vscode.postMessage({
        type: 'moveColumn',
        name: dragData.column,
        toIndex,
      });
    });

    for (const column of board.columns) {
      boardEl.appendChild(renderColumn(column));
    }

    // Add column placeholder
    const addColDiv = el('div', 'add-column-placeholder');
    const addColBtn = el('button');
    addColBtn.textContent = '+ 列を追加';
    addColBtn.onclick = (event) => addColumn(event.currentTarget);
    addColDiv.appendChild(addColBtn);
    boardEl.appendChild(addColDiv);

    app.appendChild(boardEl);

    // Restore where the user was: the card they just moved with the keyboard,
    // otherwise the quick-add box so they can keep typing.
    if (pendingFocusTaskId) {
      const id = pendingFocusTaskId;
      pendingFocusTaskId = null;
      persistState();
      const cardEl = app.querySelector('[data-task-id="' + cssEscape(id) + '"]');
      if (cardEl) {
        cardEl.focus();
        cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    } else if (quickAddColumn) {
      const quickInput = app.querySelector('.quick-add-input');
      if (quickInput) {
        quickInput.focus();
      } else {
        quickAddColumn = null;
        persistState();
      }
    }
  }

  function renderFilterBar() {
    const bar = el('div', 'filter-bar');
    const options = getFilterOptions();

    const search = el('input', 'filter-search');
    search.type = 'search';
    search.placeholder = 'カードを検索...';
    search.value = filters.text;
    search.oninput = () => updateTextFilter(search.value);
    bar.appendChild(search);

    bar.appendChild(renderSelectFilter('担当者', 'assignee', options.assignees));
    bar.appendChild(renderSelectFilter('タグ', 'tag', options.tags));
    bar.appendChild(renderSelectFilter('優先度', 'priority', ['critical', 'high', 'medium', 'low']));
    bar.appendChild(renderSelectFilter('作業量', 'workload', ['easy', 'normal', 'hard', 'extreme']));
    bar.appendChild(renderSelectFilter('期限', 'due', ['overdue', 'today', 'upcoming', 'no due date', ...options.dueDates]));

    const quick = el('div', 'quick-filters');
    quick.appendChild(renderChip('期限超過', filters.due === 'overdue', () => {
      updateFilters({ due: filters.due === 'overdue' ? '' : 'overdue' });
    }));
    quick.appendChild(renderChip('高優先度以上', filters.priority === 'high+', () => {
      updateFilters({ priority: filters.priority === 'high+' ? '' : 'high+' });
    }));
    quick.appendChild(renderChip('高負荷以上', filters.workload === 'hard+', () => {
      updateFilters({ workload: filters.workload === 'hard+' ? '' : 'hard+' });
    }));
    bar.appendChild(quick);

    if (hasActiveFilters()) {
      const clearBtn = el('button', 'secondary');
      clearBtn.textContent = 'クリア';
      clearBtn.onclick = () => updateFilters({
        text: '',
        assignee: '',
        tag: '',
        priority: '',
        workload: '',
        due: '',
      });
      bar.appendChild(clearBtn);
    }

    return bar;
  }

  function renderStatsBar() {
    const stats = getBoardStats();
    const bar = el('div', 'stats-bar');

    const filtered = hasActiveFilters();
    bar.appendChild(renderStat(filtered ? '表示中のカード' : 'カード', filtered ? stats.visibleCards + '/' + stats.totalCards : String(stats.totalCards)));
    bar.appendChild(renderColumnStats(filtered ? '列ごとの表示中カード数' : '列ごとのカード数', stats.columnCounts));
    bar.appendChild(renderStat('期限超過', String(stats.overdueCards), stats.overdueCards > 0 ? 'danger' : ''));
    bar.appendChild(renderStat('作業量ポイント', String(stats.workloadTotal), '', '作業量ポイント: 簡単=1, 普通=2, 難しい=3, 非常に困難=5'));
    bar.appendChild(renderStat('サブタスク', stats.completedSubtasks + '/' + stats.totalSubtasks));

    return bar;
  }

  function renderStat(label, value, modifier, title) {
    const item = el('div', 'stat-item' + (modifier ? ' ' + modifier : ''));
    if (title) item.title = title;
    const labelEl = el('span', 'stat-label');
    labelEl.textContent = label;
    item.appendChild(labelEl);

    const valueEl = el('span', 'stat-value');
    valueEl.textContent = value;
    item.appendChild(valueEl);
    return item;
  }

  function renderColumnStats(label, columnCounts) {
    const item = el('div', 'stat-item stat-columns');
    const labelEl = el('span', 'stat-label');
    labelEl.textContent = label;
    item.appendChild(labelEl);

    const chips = el('div', 'stat-column-chips');
    for (const column of columnCounts) {
      const chip = el('span', 'stat-column-chip');
      const name = el('span', 'stat-column-name');
      name.textContent = column.name;
      chip.appendChild(name);

      const count = el('span', 'stat-column-count');
      count.textContent = String(column.count);
      chip.appendChild(count);
      chips.appendChild(chip);
    }
    if (columnCounts.length === 0) {
      chips.textContent = '0';
    }
    item.appendChild(chips);
    return item;
  }

  function renderSelectFilter(label, key, values) {
    const select = document.createElement('select');
    select.className = 'filter-select';
    select.title = label + 'で絞り込み';

    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = label;
    select.appendChild(empty);

    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = formatFilterLabel(value);
      select.appendChild(option);
    }

    select.value = filters[key] || '';
    select.onchange = () => updateFilters({ [key]: select.value });
    return select;
  }

  function renderChip(label, isActive, onClick) {
    const chip = el('button', 'filter-chip' + (isActive ? ' active' : ''));
    chip.textContent = label;
    chip.onclick = onClick;
    return chip;
  }

  function updateFilters(next) {
    filters = { ...filters, ...next };
    persistState();
    render();
  }

  function updateTextFilter(value) {
    filters = { ...filters, text: value };
    persistState();
    window.clearTimeout(textFilterTimer);
    textFilterTimer = window.setTimeout(() => {
      render();
      const search = document.querySelector('.filter-search');
      if (search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    }, 150);
  }

  function hasActiveFilters() {
    return Boolean(
      filters.text ||
      filters.assignee ||
      filters.tag ||
      filters.priority ||
      filters.workload ||
      filters.due
    );
  }

  function persistState() {
    vscode.setState({
      collapsedGroups,
      filters,
      confirmationPrefs,
      expandedSubtasks,
      // Kept so an external file change (which reloads this webview) does not
      // interrupt continuous quick-add or lose keyboard focus mid-move.
      quickAddColumn,
      pendingFocusTaskId,
    });
  }

  function getAllTasks() {
    return board.columns.flatMap(column => column.tasks);
  }

  function getBoardStats() {
    const today = getToday();
    const allTasks = getAllTasks();
    const visibleTasks = allTasks.filter(matchesFilters);
    let overdueCards = 0;
    let workloadTotal = 0;
    let completedSubtasks = 0;
    let totalSubtasks = 0;

    for (const task of visibleTasks) {
      if (isOverdue(task.dueDate, today)) {
        overdueCards++;
      }
      workloadTotal += getWorkloadPoints(task.workload);
      for (const subtask of task.subtasks || []) {
        totalSubtasks++;
        if (subtask.done) {
          completedSubtasks++;
        }
      }
    }

    return {
      totalCards: allTasks.length,
      visibleCards: visibleTasks.length,
      columnCounts: board.columns.map(column => ({
        name: column.name,
        count: column.tasks.filter(matchesFilters).length,
      })),
      overdueCards,
      workloadTotal,
      completedSubtasks,
      totalSubtasks,
    };
  }

  function getFilterOptions() {
    const assignees = new Set();
    const tags = new Set();
    const dueDates = new Set();
    for (const task of getAllTasks()) {
      if (task.assignee) assignees.add(task.assignee);
      if (task.dueDate) dueDates.add(task.dueDate);
      for (const tag of task.tags || []) tags.add(tag);
    }
    return {
      assignees: Array.from(assignees).sort((a, b) => a.localeCompare(b)),
      tags: Array.from(tags).sort((a, b) => a.localeCompare(b)),
      dueDates: Array.from(dueDates).sort((a, b) => a.localeCompare(b)),
    };
  }

  function matchesFilters(task) {
    if (filters.text) {
      const needle = filters.text.toLowerCase();
      const haystack = [
        task.title,
        task.description,
        task.assignee,
        task.group,
        task.priority,
        task.workload,
        task.dueDate,
        task.source,
        ...(task.tags || []),
        ...((task.subtasks || []).map(st => st.title)),
      ].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (filters.assignee && task.assignee !== filters.assignee) return false;
    if (filters.tag && !(task.tags || []).includes(filters.tag)) return false;
    if (filters.priority && !matchesPriorityFilter(task.priority, filters.priority)) return false;
    if (filters.workload && !matchesWorkloadFilter(task.workload, filters.workload)) return false;
    if (filters.due && !matchesDueFilter(task.dueDate, filters.due)) return false;

    return true;
  }

  function matchesPriorityFilter(priority, value) {
    const current = priority || 'medium';
    if (value === 'high+') return current === 'critical' || current === 'high';
    return current === value;
  }

  function matchesWorkloadFilter(workload, value) {
    const current = workload || 'normal';
    if (value === 'hard+') return current === 'extreme' || current === 'hard';
    return current === value;
  }

  function matchesDueFilter(dueDate, value) {
    if (value === 'no due date') return !dueDate;
    if (!dueDate) return false;

    const today = getToday();
    const due = new Date(dueDate + 'T00:00:00');
    if (Number.isNaN(due.getTime())) return false;

    if (value === 'overdue') return due < today;
    if (value === 'today') return due.getTime() === today.getTime();
    if (value === 'upcoming') return due > today;
    return dueDate === value;
  }

  function getToday() {
    const today = new Date();
    today.setHours(0,0,0,0);
    return today;
  }

  function isOverdue(dueDate, today) {
    if (!dueDate) return false;
    const due = new Date(dueDate + 'T00:00:00');
    return !Number.isNaN(due.getTime()) && due < today;
  }

  function getWorkloadPoints(workload) {
    switch (workload || 'normal') {
      case 'easy': return 1;
      case 'hard': return 3;
      case 'extreme': return 5;
      case 'normal':
      default:
        return 2;
    }
  }

  const VALUE_LABELS = {
    'high+': '高優先度以上',
    'hard+': '高負荷以上',
    'no due date': '期限日なし',
    'overdue': '期限超過',
    'today': '今日',
    'upcoming': '今後',
    critical: '緊急',
    high: '高',
    medium: '中',
    low: '低',
    easy: '簡単',
    normal: '普通',
    hard: '難しい',
    extreme: '非常に困難',
  };

  function formatFilterLabel(value) {
    if (Object.prototype.hasOwnProperty.call(VALUE_LABELS, value)) return VALUE_LABELS[value];
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function renderColumn(column) {
    const colEl = el('div', 'column');
    colEl.dataset.column = column.name;
    const visibleTasks = column.tasks.filter(matchesFilters);

    // Header
    const header = el('div', 'column-header');

    const columnDragHandle = el('button', 'column-drag-handle');
    columnDragHandle.textContent = '::';
    columnDragHandle.title = '列をドラッグ';
    columnDragHandle.draggable = true;
    columnDragHandle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    columnDragHandle.addEventListener('dragstart', (e) => {
      dragData = { type: 'column', column: column.name };
      colEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    columnDragHandle.addEventListener('dragend', () => {
      colEl.classList.remove('dragging');
      clearDragState();
    });
    header.appendChild(columnDragHandle);

    const title = el('span', 'column-title');
    title.textContent = column.name;
    title.title = 'クリックして名前を変更';
    title.onclick = () => renameColumn(column.name);
    header.appendChild(title);

    const count = el('span', 'column-count');
    count.textContent = hasActiveFilters()
      ? visibleTasks.length + '/' + column.tasks.length
      : String(column.tasks.length);
    header.appendChild(count);

    const colActions = el('div', 'column-actions');

    if (column.tasks.length > 1) {
      const sortBtn = el('button');
      sortBtn.textContent = '⇅';
      sortBtn.title = 'この列を並べ替え';
      sortBtn.onclick = () => openSortModal(column.name);
      colActions.appendChild(sortBtn);
    }

    const delColBtn = el('button');
    delColBtn.textContent = '✕';
    delColBtn.title = '列を削除';
    delColBtn.onclick = () => {
      requestConfirmation('deleteColumn', {
        title: '列を削除',
        message: column.tasks.length > 0
          ? '「' + column.name + '」と' + column.tasks.length + '件のカードをすべて削除しますか?'
          : '「' + column.name + '」を削除しますか?',
        confirmText: '削除',
        danger: true,
      }, () => {
        vscode.postMessage({ type: 'deleteColumn', name: column.name });
      });
    };
    colActions.appendChild(delColBtn);
    header.appendChild(colActions);
    colEl.appendChild(header);

    // Body
    const body = el('div', 'column-body');
    body.dataset.column = column.name;

    body.addEventListener('dragover', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.classList.add('drag-over');
      if (dragData && dragData.type === 'group') {
        updateGroupDropIndicator(body, e.clientY);
      } else {
        updateDropIndicator(body, e.clientY);
      }
    });

    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) {
        body.classList.remove('drag-over');
        removeDropIndicators(body);
      }
    });

    body.addEventListener('drop', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      body.classList.remove('drag-over');
      removeDropIndicators(body);

      if (!dragData) return;
      if (dragData.type === 'group') {
        moveGroupTo(body, column.name, e.clientY);
        return;
      }

      const toIndex = getDropCards(body).length > 0 ? getDropIndex(body, e.clientY) : column.tasks.length;

      vscode.postMessage({
        type: 'moveTaskToGroup',
        taskId: dragData.taskId,
        fromColumn: dragData.fromColumn,
        toColumn: column.name,
        toIndex: toIndex,
        group: '',
      });
    });

    // Group tasks
    const grouped = {};
    const ungrouped = [];
    for (const task of visibleTasks) {
      if (task.group) {
        if (!grouped[task.group]) grouped[task.group] = [];
        grouped[task.group].push(task);
      } else {
        ungrouped.push(task);
      }
    }

    // Render grouped tasks
    const groupNames = Object.keys(grouped);
    for (const gName of groupNames) {
      const groupEl = el('div', 'task-group');
      groupEl.dataset.group = gName;

      const gHeader = el('div', 'group-header');
      const groupDragHandle = el('button', 'group-drag-handle');
      groupDragHandle.textContent = '::';
      groupDragHandle.title = 'グループをドラッグ';
      groupDragHandle.draggable = true;
      groupDragHandle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      groupDragHandle.addEventListener('dragstart', (e) => {
        dragData = { type: 'group', group: gName, fromColumn: column.name };
        groupEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      groupDragHandle.addEventListener('dragend', () => {
        groupEl.classList.remove('dragging');
        clearDragState();
      });
      gHeader.appendChild(groupDragHandle);

      const chevron = el('span', 'group-chevron');
      chevron.textContent = '▼';
      gHeader.appendChild(chevron);

      const gLabel = el('span');
      gLabel.textContent = gName;
      gHeader.appendChild(gLabel);

      const gCount = el('span', 'group-count');
      gCount.textContent = String(grouped[gName].length);
      gHeader.appendChild(gCount);

      const gBody = el('div', 'group-body');
      gBody.dataset.group = gName;
      gBody.dataset.column = column.name;

      // Group drop target: dropping here assigns the group + handles reorder
      gBody.addEventListener('dragover', (e) => {
        if (dragData && dragData.type === 'column') return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (dragData && dragData.type === 'group') {
          updateGroupDropIndicator(body, e.clientY);
          return;
        }
        gBody.classList.add('drag-over');
        groupEl.classList.add('group-drop-target');
        updateDropIndicator(gBody, e.clientY);
      });
      gBody.addEventListener('dragleave', (e) => {
        if (!gBody.contains(e.relatedTarget)) {
          gBody.classList.remove('drag-over');
          groupEl.classList.remove('group-drop-target');
          removeDropIndicators(gBody);
        }
      });
      gBody.addEventListener('drop', (e) => {
        if (dragData && dragData.type === 'column') return;
        e.preventDefault();
        e.stopPropagation();
        gBody.classList.remove('drag-over');
        groupEl.classList.remove('group-drop-target');
        removeDropIndicators(gBody);
        if (!dragData) return;
        if (dragData.type === 'group') {
          moveGroupTo(body, column.name, e.clientY);
          return;
        }

        const dropIdx = getDropIndex(gBody, e.clientY);
        // Find absolute index in column.tasks for the group
        const groupTaskIds = grouped[gName]
          .filter(t => !dragData || t.id !== dragData.taskId)
          .map(t => t.id);
        const placement = getTaskPlacement(groupTaskIds, dropIdx);
        let absoluteIdx = 0;
        if (dropIdx < groupTaskIds.length) {
          absoluteIdx = column.tasks.findIndex(t => t.id === groupTaskIds[dropIdx]);
        } else if (groupTaskIds.length > 0) {
          absoluteIdx = column.tasks.findIndex(t => t.id === groupTaskIds[groupTaskIds.length - 1]) + 1;
        }
        vscode.postMessage({
          type: 'moveTaskToGroup',
          taskId: dragData.taskId,
          fromColumn: dragData.fromColumn,
          toColumn: column.name,
          toIndex: absoluteIdx,
          beforeTaskId: placement.beforeTaskId,
          afterTaskId: placement.afterTaskId,
          group: gName,
        });
      });

      // Also make the group header a drop target
      gHeader.addEventListener('dragover', (e) => {
        if (dragData && dragData.type === 'column') return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (dragData && dragData.type === 'group') {
          updateGroupDropIndicator(body, e.clientY);
          return;
        }
        groupEl.classList.add('group-drop-target');
      });
      gHeader.addEventListener('dragleave', (e) => {
        if (!gHeader.contains(e.relatedTarget)) {
          groupEl.classList.remove('group-drop-target');
        }
      });
      gHeader.addEventListener('drop', (e) => {
        if (dragData && dragData.type === 'column') return;
        e.preventDefault();
        e.stopPropagation();
        groupEl.classList.remove('group-drop-target');
        if (!dragData) return;
        if (dragData.type === 'group') {
          moveGroupTo(body, column.name, e.clientY);
          return;
        }

        vscode.postMessage({
          type: 'moveTaskToGroup',
          taskId: dragData.taskId,
          fromColumn: dragData.fromColumn,
          toColumn: column.name,
          toIndex: column.tasks.length,
          afterTaskId: getLastTaskId(grouped[gName], dragData.taskId),
          group: gName,
        });
      });

      for (const task of grouped[gName]) {
        gBody.appendChild(renderCard(task, column.name));
      }

      // Restore collapsed state
      const stateKey = column.name + '::' + gName;
      const isCollapsed = collapsedGroups[stateKey];
      if (isCollapsed) {
        chevron.classList.add('collapsed');
        gBody.classList.add('collapsed');
      }

      // Group edit button
      const gEditBtn = el('button', 'group-edit-btn');
      gEditBtn.textContent = '✎';
      gEditBtn.title = 'グループ名を変更';
      gEditBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openGroupModal(column.name, gName);
      });
      gHeader.appendChild(gEditBtn);

      gHeader.addEventListener('click', (ev) => {
        if (gEditBtn.contains(ev.target)) return;
        const nowCollapsed = !gBody.classList.contains('collapsed');
        gBody.classList.toggle('collapsed');
        chevron.classList.toggle('collapsed');
        collapsedGroups[stateKey] = nowCollapsed;
        persistState();
      });

      groupEl.appendChild(gHeader);
      groupEl.appendChild(gBody);
      body.appendChild(groupEl);
    }

    // Ungrouped drop zone: dropping here removes the group + handles reorder
    const ungroupedZone = el('div', 'ungrouped-zone');

    ungroupedZone.addEventListener('dragover', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dragData && dragData.type === 'group') {
        updateGroupDropIndicator(body, e.clientY);
        return;
      }
      ungroupedZone.classList.add('drag-over');
      updateDropIndicator(ungroupedZone, e.clientY);
    });
    ungroupedZone.addEventListener('dragleave', (e) => {
      if (!ungroupedZone.contains(e.relatedTarget)) {
        ungroupedZone.classList.remove('drag-over');
        removeDropIndicators(ungroupedZone);
      }
    });
    ungroupedZone.addEventListener('drop', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.stopPropagation();
      ungroupedZone.classList.remove('drag-over');
      removeDropIndicators(ungroupedZone);
      if (!dragData) return;
      if (dragData.type === 'group') {
        moveGroupTo(body, column.name, e.clientY);
        return;
      }

      const dropIdx = getDropIndex(ungroupedZone, e.clientY);
      // Find absolute index in column.tasks for ungrouped area
      const ungroupedIds = ungrouped
        .filter(t => !dragData || t.id !== dragData.taskId)
        .map(t => t.id);
      const placement = getTaskPlacement(ungroupedIds, dropIdx);
      let absoluteIdx = column.tasks.length;
      if (dropIdx < ungroupedIds.length) {
        absoluteIdx = column.tasks.findIndex(t => t.id === ungroupedIds[dropIdx]);
      }
      vscode.postMessage({
        type: 'moveTaskToGroup',
        taskId: dragData.taskId,
        fromColumn: dragData.fromColumn,
        toColumn: column.name,
        toIndex: absoluteIdx,
        beforeTaskId: placement.beforeTaskId,
        afterTaskId: placement.afterTaskId,
        group: '',
      });
    });

    for (const task of ungrouped) {
      ungroupedZone.appendChild(renderCard(task, column.name));
    }
    body.appendChild(ungroupedZone);

    if (hasActiveFilters() && visibleTasks.length === 0) {
      const empty = el('div', 'filter-empty');
      empty.textContent = '一致するカードがありません';
      body.appendChild(empty);
    }

    const columnEndZone = el('div', 'column-end-drop-zone');
    columnEndZone.title = '列の末尾にドロップ';
    columnEndZone.addEventListener('dragover', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dragData && dragData.type === 'group') {
        updateGroupDropIndicator(body, e.clientY);
        return;
      }
      columnEndZone.classList.add('drag-over');
      updateEndDropIndicator(columnEndZone);
    });
    columnEndZone.addEventListener('dragleave', (e) => {
      if (!columnEndZone.contains(e.relatedTarget)) {
        columnEndZone.classList.remove('drag-over');
        removeDropIndicators(columnEndZone);
      }
    });
    columnEndZone.addEventListener('drop', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.stopPropagation();
      columnEndZone.classList.remove('drag-over');
      removeDropIndicators(columnEndZone);
      if (!dragData) return;
      if (dragData.type === 'group') {
        moveGroupTo(body, column.name, e.clientY);
        return;
      }

      vscode.postMessage({
        type: 'moveTaskToGroup',
        taskId: dragData.taskId,
        fromColumn: dragData.fromColumn,
        toColumn: column.name,
        toIndex: column.tasks.length,
        group: '',
      });
    });
    body.appendChild(columnEndZone);

    // Add task button
    const addBtn = el('button', 'add-card-btn');
    addBtn.textContent = '+ タスクを追加';
    addBtn.onclick = () => startQuickAdd(column.name);
    addBtn.addEventListener('dragover', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dragData && dragData.type === 'group') {
        updateGroupDropIndicator(body, e.clientY);
        return;
      }
      updateEndDropIndicator(columnEndZone);
    });
    addBtn.addEventListener('drop', (e) => {
      if (dragData && dragData.type === 'column') return;
      e.preventDefault();
      e.stopPropagation();
      if (!dragData) return;
      if (dragData.type === 'group') {
        moveGroupTo(body, column.name, e.clientY);
        return;
      }

      vscode.postMessage({
        type: 'moveTaskToGroup',
        taskId: dragData.taskId,
        fromColumn: dragData.fromColumn,
        toColumn: column.name,
        toIndex: column.tasks.length,
        group: '',
      });
    });

    if (quickAddColumn === column.name) {
      body.appendChild(renderQuickAddForm(column.name));
    } else {
      body.appendChild(addBtn);
    }

    colEl.appendChild(body);
    return colEl;
  }

  // Quick add: type a title and press Enter to keep adding cards without
  // opening the full form. "詳細入力" escalates to the full task modal.
  function startQuickAdd(columnName) {
    quickAddColumn = columnName;
    persistState();
    render();
  }

  function cancelQuickAdd() {
    quickAddColumn = null;
    persistState();
    render();
  }

  function renderQuickAddForm(columnName) {
    const wrap = el('div', 'quick-add');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:4px;';

    const input = el('input', 'quick-add-input');
    input.type = 'text';
    input.placeholder = 'タイトルを入力して Enter';
    input.style.cssText = 'width:100%;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--accent);border-radius:3px;padding:6px 8px;font-size:13px;font-family:inherit;';

    const submit = () => {
      const title = input.value.trim();
      if (!title) {
        cancelQuickAdd();
        return;
      }
      // Stay in quick-add mode so the next card can be typed right away.
      vscode.postMessage({ type: 'addTask', column: columnName, title });
      input.value = '';
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelQuickAdd();
      }
    });
    wrap.appendChild(input);

    const row = el('div');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    const addBtn = el('button');
    addBtn.type = 'button';
    addBtn.textContent = '追加';
    addBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
    addBtn.onclick = submit;
    row.appendChild(addBtn);

    const detailBtn = el('button', 'secondary');
    detailBtn.type = 'button';
    detailBtn.textContent = '詳細入力';
    detailBtn.title = '説明や期限などを入力する画面を開く';
    detailBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
    detailBtn.onclick = () => {
      const title = input.value.trim();
      quickAddColumn = null;
      persistState();
      render();
      openTaskModal(null, columnName, title);
    };
    row.appendChild(detailBtn);

    const cancelBtn = el('button', 'secondary');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.cssText = 'padding:3px 10px;font-size:11px;margin-left:auto;';
    cancelBtn.onclick = () => cancelQuickAdd();
    row.appendChild(cancelBtn);

    wrap.appendChild(row);
    return wrap;
  }

  function renderCard(task, columnName) {
    const card = el('div', 'card');
    card.draggable = true;
    card.dataset.taskId = task.id;
    card.style.position = 'relative';
    card.style.paddingLeft = '16px';
    let cardWasDragged = false;

    // Priority color strip
    const dot = el('div', 'priority-dot priority-dot-' + (task.priority || 'medium'));
    card.appendChild(dot);

    card.addEventListener('dragstart', (e) => {
      cardWasDragged = true;
      dragData = { type: 'card', taskId: task.id, fromColumn: columnName };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      clearDragState();
      window.setTimeout(() => {
        cardWasDragged = false;
      }, 100);
    });

    card.addEventListener('click', (e) => {
      if (cardWasDragged || e.target.closest('button')) return;
      openTaskModal(task, columnName);
    });

    // Keyboard access: focusable card with editing, navigation, and movement.
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', task.title + ' を編集');
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;

      // Enter / Space: open the editor.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTaskModal(task, columnName);
        return;
      }

      // n: quick-add a task to this card's column.
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        startQuickAdd(columnName);
        return;
      }

      if (!e.key.startsWith('Arrow')) return;

      // Ctrl/Cmd + arrows: move the card between/within columns.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.key === 'ArrowUp') moveCardVertically(task, columnName, -1);
        else if (e.key === 'ArrowDown') moveCardVertically(task, columnName, 1);
        else if (e.key === 'ArrowLeft') moveCardHorizontally(task, columnName, -1);
        else if (e.key === 'ArrowRight') moveCardHorizontally(task, columnName, 1);
        return;
      }

      // Plain arrows: move focus between cards.
      if (!e.altKey && !e.shiftKey) {
        e.preventDefault();
        focusAdjacentCard(card, e.key);
      }
    });

    const titleEl = el('div', 'card-title');
    titleEl.textContent = task.title;
    card.appendChild(titleEl);

    // Meta badges row (priority + workload)
    const meta = el('div', 'card-meta');
    if (task.priority && task.priority !== 'medium') {
      const pb = el('span', 'priority-badge priority-' + task.priority);
      pb.textContent = formatFilterLabel(task.priority);
      meta.appendChild(pb);
    }
    if (task.repeat) {
      const rb = el('span', 'priority-badge');
      rb.textContent = '🔁 ' + formatRepeatLabel(task.repeat);
      rb.title = '完了列に移動すると次回分が作成されます';
      rb.style.cssText = 'background:var(--badge-bg);color:var(--badge-fg);text-transform:none;';
      meta.appendChild(rb);
    }
    if (task.workload && task.workload !== 'normal') {
      const wb = el('span', 'workload-badge workload-' + task.workload);
      wb.textContent = formatFilterLabel(task.workload);
      meta.appendChild(wb);
    }
    if (meta.childNodes.length > 0) card.appendChild(meta);

    // Due date
    if (task.dueDate) {
      const due = el('div', 'card-due');
      const today = new Date(); today.setHours(0,0,0,0);
      const dueDate = new Date(task.dueDate + 'T00:00:00');
      const isOverdue = dueDate < today;
      if (isOverdue) due.classList.add('overdue');
      due.textContent = '📅 ' + task.dueDate + (isOverdue ? ' (期限超過)' : '');
      card.appendChild(due);
    }

    if (task.description) {
      const desc = el('div', 'card-desc');
      appendTextWithLinks(desc, task.description);
      card.appendChild(desc);
    }

    // Assignee
    if (task.assignee) {
      const assigneeEl = el('div', 'card-assignee');
      assigneeEl.textContent = '👤 ' + task.assignee;
      card.appendChild(assigneeEl);
    }

    if (task.source) {
      const sourceEl = el('div', 'card-source');
      sourceEl.textContent = '↗ ' + task.source;
      sourceEl.title = 'ソースボタンでこのファイルを開く';
      card.appendChild(sourceEl);
    }

    // Subtasks: progress toggles an inline checklist that can be ticked here.
    if (task.subtasks && task.subtasks.length > 0) {
      const doneCount = task.subtasks.filter(s => s.done).length;
      const expanded = !!expandedSubtasks[task.id];

      const prog = el('button', 'subtask-progress');
      prog.type = 'button';
      prog.textContent = (expanded ? '▾ ' : '▸ ') + '✓ ' + doneCount + '/' + task.subtasks.length + ' サブタスク';
      prog.title = expanded ? 'サブタスクを隠す' : 'サブタスクを表示';
      prog.style.cssText = 'display:block;background:transparent;color:var(--fg);border:none;padding:0;margin-bottom:3px;font-size:10px;opacity:0.7;cursor:pointer;font-family:inherit;text-align:left;';
      prog.onclick = (e) => {
        e.stopPropagation();
        expandedSubtasks[task.id] = !expanded;
        persistState();
        render();
      };
      card.appendChild(prog);

      if (expanded) {
        const list = el('div', 'card-subtasks');
        task.subtasks.forEach((subtask, index) => {
          const row = el('label', 'subtask-item' + (subtask.done ? ' done' : ''));
          row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:1px 0;cursor:pointer;';
          row.addEventListener('click', (e) => e.stopPropagation());

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!subtask.done;
          cb.style.margin = '0';
          cb.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({
              type: 'toggleSubtask',
              taskId: task.id,
              index,
              done: cb.checked,
            });
          };
          row.appendChild(cb);

          const label = el('span');
          label.textContent = subtask.title;
          row.appendChild(label);
          list.appendChild(row);
        });
        card.appendChild(list);
      }
    }

    if (task.tags && task.tags.length > 0) {
      const tagsEl = el('div', 'card-tags');
      for (const tag of task.tags) {
        const tagEl = el('span', 'tag');
        tagEl.textContent = tag;
        tagsEl.appendChild(tagEl);
      }
      card.appendChild(tagsEl);
    }

    // Overlay actions
    const overlay = el('div', 'card-overlay');
    if (task.source) {
      const sourceBtn = el('button', 'card-action action-source');
      sourceBtn.textContent = '↗';
      sourceBtn.title = 'ソースを開く';
      sourceBtn.onclick = (e) => {
        e.stopPropagation();
        openSource(task.source);
      };
      overlay.appendChild(sourceBtn);
    }

    const editBtn = el('button');
    editBtn.textContent = '✎';
    editBtn.title = 'タスクを編集';
    editBtn.onclick = (e) => { e.stopPropagation(); openTaskModal(task, columnName); };
    overlay.appendChild(editBtn);

    if (boardConfig.canArchiveCards !== false) {
      const archiveBtn = el('button', 'card-action action-archive');
      archiveBtn.textContent = '⇩';
      archiveBtn.title = 'タスクをアーカイブ';
      archiveBtn.onclick = (e) => {
        e.stopPropagation();
        archiveTask(task, columnName);
      };
      overlay.appendChild(archiveBtn);
    }

    if (boardConfig.isArchiveBoard === true) {
      const restoreBtn = el('button', 'card-action action-source');
      restoreBtn.textContent = '⇧';
      restoreBtn.title = '元のボードに復元';
      restoreBtn.onclick = (e) => {
        e.stopPropagation();
        restoreTask(task, columnName);
      };
      overlay.appendChild(restoreBtn);
    }

    const delBtn = el('button', 'card-action action-delete');
    delBtn.textContent = '🗑';
    delBtn.title = 'タスクを削除';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteTask(task);
    };
    overlay.appendChild(delBtn);

    card.appendChild(overlay);
    return card;
  }

  function openTaskDetailsModal(task, columnName) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');

    const header = el('div', 'modal-header');
    const heading = el('h2');
    heading.textContent = task.title;
    header.appendChild(heading);

    const closeBtn = el('button', 'modal-icon-btn');
    closeBtn.textContent = '×';
    closeBtn.title = '閉じる';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    modal.appendChild(header);

    appendDetail(modal, '列', columnName);
    if (task.group) appendDetail(modal, 'グループ', task.group);

    const metaValues = [];
    metaValues.push('優先度: ' + formatFilterLabel(task.priority || 'medium'));
    metaValues.push('作業量: ' + formatFilterLabel(task.workload || 'normal'));
    if (task.dueDate) metaValues.push('期限: ' + task.dueDate);
    if (task.assignee) metaValues.push('担当者: ' + task.assignee);
    if (task.source) metaValues.push('ソース: ' + task.source);
    appendDetail(modal, '詳細', metaValues.join('\n'));

    appendDetail(modal, '説明', task.description || '', '説明はありません', true);

    if (task.tags && task.tags.length > 0) {
      const section = detailSection('タグ');
      const tags = el('div', 'detail-tags');
      for (const tag of task.tags) {
        const tagEl = el('span', 'tag');
        tagEl.textContent = tag;
        tags.appendChild(tagEl);
      }
      section.appendChild(tags);
      modal.appendChild(section);
    }

    if (task.subtasks && task.subtasks.length > 0) {
      const section = detailSection('サブタスク');
      const list = el('div', 'detail-subtasks');
      for (const subtask of task.subtasks) {
        const row = el('div', 'detail-subtask' + (subtask.done ? ' done' : ''));
        const mark = el('span');
        mark.textContent = subtask.done ? '✓' : '□';
        row.appendChild(mark);
        const title = el('span');
        title.textContent = subtask.title;
        row.appendChild(title);
        list.appendChild(row);
      }
      section.appendChild(list);
      modal.appendChild(section);
    }

    const actions = el('div', 'modal-actions');
    const editBtn = el('button', 'secondary');
    editBtn.textContent = '編集';
    editBtn.onclick = () => {
      overlay.remove();
      openTaskModal(task, columnName);
    };
    actions.appendChild(editBtn);

    if (task.source) {
      const sourceBtn = el('button', 'secondary');
      sourceBtn.textContent = 'ソースを開く';
      sourceBtn.onclick = () => openSource(task.source);
      actions.appendChild(sourceBtn);
    }

    if (boardConfig.canArchiveCards !== false) {
      const archiveBtn = el('button', 'archive-action');
      archiveBtn.textContent = 'アーカイブ';
      archiveBtn.onclick = () => {
        archiveTask(task, columnName, () => overlay.remove());
      };
      actions.appendChild(archiveBtn);
    }

    const deleteBtn = el('button', 'danger');
    deleteBtn.textContent = '削除';
    deleteBtn.onclick = () => {
      deleteTask(task, () => overlay.remove());
    };
    actions.appendChild(deleteBtn);
    modal.appendChild(actions);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => closeBtn.focus(), 50);
  }

  function openTaskDetailsById(taskId) {
    const found = findTaskWithColumn(taskId);
    if (!found) {
      showNotice('このボードにはカードが見つかりませんでした。', false);
      return;
    }

    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
    render();
    const cardEl = document.querySelector('[data-task-id="' + cssEscape(taskId) + '"]');
    if (cardEl) {
      cardEl.scrollIntoView({ block: 'center', inline: 'center' });
    }
    openTaskDetailsModal(found.task, found.column.name);
  }

  function findTaskWithColumn(taskId) {
    for (const column of board.columns) {
      const task = column.tasks.find(task => task.id === taskId);
      if (task) {
        return { task, column };
      }
    }
    return undefined;
  }

  function archiveTask(task, columnName, afterArchive) {
    requestConfirmation('archiveCard', {
      title: 'カードをアーカイブ',
      message: '「' + task.title + '」をarchive.kanban.mdにアーカイブしますか?',
      confirmText: 'アーカイブ',
      danger: false,
    }, () => {
      vscode.postMessage({
        type: 'archiveTask',
        taskId: task.id,
        task,
        taskIndex: getTaskIndex(columnName, task.id),
        fromColumn: columnName,
      });
      if (afterArchive) afterArchive();
    });
  }

  function deleteTask(task, afterDelete) {
    requestConfirmation('deleteTask', {
      title: 'カードを削除',
      message: '「' + task.title + '」を削除しますか?',
      confirmText: '削除',
      danger: true,
    }, () => {
      vscode.postMessage({ type: 'deleteTask', taskId: task.id });
      if (afterDelete) afterDelete();
    });
  }

  function openSource(source) {
    vscode.postMessage({ type: 'openSource', source });
  }

  function restoreTask(task, columnName, afterRestore) {
    requestConfirmation('restoreTask', {
      title: 'カードを復元',
      message: '「' + task.title + '」を' + columnName + 'に戻しますか?',
      confirmText: '復元',
      danger: false,
    }, () => {
      vscode.postMessage({ type: 'restoreTask', taskId: task.id });
      if (afterRestore) afterRestore();
    });
  }

  function requestUndo() {
    vscode.postMessage({ type: 'undo' });
  }

  const REPEAT_LABELS = {
    daily: '毎日',
    weekly: '毎週',
    monthly: '毎月',
    yearly: '毎年',
  };

  function formatRepeatLabel(value) {
    return REPEAT_LABELS[value] || value;
  }

  function openSortModal(columnName) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal confirm-modal');

    const title = el('h2');
    title.textContent = '列の並べ替え';
    modal.appendChild(title);

    const message = el('div', 'confirm-message');
    message.textContent = '「' + columnName + '」のカードを並べ替えます。グループ内での並びが対象です。';
    modal.appendChild(message);

    const options = el('div');
    options.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px;';
    [['due', '期限順(期限なしは最後)'], ['priority', '優先度順'], ['title', 'タイトル順']].forEach(([by, label]) => {
      const btn = el('button', 'secondary');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.textAlign = 'left';
      btn.onclick = () => {
        overlay.remove();
        vscode.postMessage({ type: 'sortColumn', name: columnName, by });
      };
      options.appendChild(btn);
    });
    modal.appendChild(options);

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'secondary');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.onclick = () => overlay.remove();
    actions.appendChild(cancelBtn);
    modal.appendChild(actions);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => cancelBtn.focus(), 50);
  }

  function requestConfirmation(kind, options, onConfirm) {
    if (confirmationPrefs[kind]) {
      onConfirm();
      return;
    }

    openConfirmationModal({
      title: options.title,
      message: options.message,
      confirmText: options.confirmText,
      danger: options.danger,
      onConfirm: (remember) => {
        if (remember) {
          confirmationPrefs[kind] = true;
          persistState();
        }
        onConfirm();
      },
    });
  }

  function openConfirmationModal(options) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal confirm-modal');

    const title = el('h2');
    title.textContent = options.title;
    modal.appendChild(title);

    const message = el('div', 'confirm-message');
    message.textContent = options.message;
    modal.appendChild(message);

    const rememberLabel = el('label', 'remember-row');
    const rememberInput = document.createElement('input');
    rememberInput.type = 'checkbox';
    rememberLabel.appendChild(rememberInput);
    const rememberText = el('span');
    rememberText.textContent = 'この操作について今後確認しない';
    rememberLabel.appendChild(rememberText);
    modal.appendChild(rememberLabel);

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'secondary');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.onclick = () => overlay.remove();
    actions.appendChild(cancelBtn);

    const confirmBtn = el('button', options.danger ? 'danger' : '');
    confirmBtn.type = 'button';
    confirmBtn.textContent = options.confirmText;
    confirmBtn.onclick = () => {
      const remember = rememberInput.checked;
      overlay.remove();
      options.onConfirm(remember);
    };
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => confirmBtn.focus(), 50);
  }

  function appendDetail(modal, label, value, emptyText, linkify) {
    const section = detailSection(label);
    const text = el('div', 'detail-text' + (value ? '' : ' detail-empty'));
    if (value && linkify) {
      appendTextWithLinks(text, value);
    } else {
      text.textContent = value || emptyText || '';
    }
    section.appendChild(text);
    modal.appendChild(section);
  }

  function getTaskIndex(columnName, taskId) {
    const column = board.columns.find(col => col.name === columnName);
    return column ? column.tasks.findIndex(item => item.id === taskId) : -1;
  }

  function detailSection(label) {
    const section = el('div', 'detail-section');
    const labelEl = el('span', 'detail-label');
    labelEl.textContent = label;
    section.appendChild(labelEl);
    return section;
  }

  function getDropIndex(body, clientY) {
    const cards = getDropCards(body);
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return i;
      }
    }
    return cards.length;
  }

  function updateDropIndicator(body, clientY) {
    removeDropIndicators(document);
    const cards = getDropCards(body);
    const indicator = el('div', 'drop-indicator');

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        body.insertBefore(indicator, cards[i]);
        return;
      }
    }
    // Insert before the add button
    const endZone = body.querySelector('.column-end-drop-zone');
    if (endZone) {
      endZone.appendChild(indicator);
    } else {
      body.appendChild(indicator);
    }
  }

  function updateEndDropIndicator(container) {
    removeDropIndicators(document);
    container.appendChild(el('div', 'drop-indicator'));
  }

  function removeDropIndicators(container) {
    container.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  }

  function getDropCards(container) {
    return Array.from(container.children).filter(child =>
      child.classList.contains('card') && !child.classList.contains('dragging')
    );
  }

  function getTaskPlacement(taskIds, dropIndex) {
    if (dropIndex < taskIds.length) {
      return { beforeTaskId: taskIds[dropIndex] };
    }
    if (taskIds.length > 0) {
      return { afterTaskId: taskIds[taskIds.length - 1] };
    }
    return {};
  }

  function getLastTaskId(tasks, draggedTaskId) {
    const task = [...tasks].reverse().find(t => t.id !== draggedTaskId);
    return task ? task.id : undefined;
  }

  function getGroupBlocks(container) {
    return Array.from(container.children).filter(child =>
      child.classList.contains('task-group') && !child.classList.contains('dragging')
    );
  }

  function getGroupDropIndex(body, clientY) {
    const groups = getGroupBlocks(body);
    for (let i = 0; i < groups.length; i++) {
      const rect = groups[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return i;
      }
    }
    return groups.length;
  }

  function updateGroupDropIndicator(body, clientY) {
    removeDropIndicators(document);
    const groups = getGroupBlocks(body);
    const indicator = el('div', 'drop-indicator');

    for (let i = 0; i < groups.length; i++) {
      const rect = groups[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        body.insertBefore(indicator, groups[i]);
        return;
      }
    }

    const ungroupedZone = body.querySelector('.ungrouped-zone');
    if (ungroupedZone) {
      body.insertBefore(indicator, ungroupedZone);
    } else {
      body.appendChild(indicator);
    }
  }

  function moveGroupTo(body, columnName, clientY) {
    if (!dragData || dragData.type !== 'group') return;
    vscode.postMessage({
      type: 'moveGroup',
      group: dragData.group,
      fromColumn: dragData.fromColumn,
      toColumn: columnName,
      toGroupIndex: getGroupDropIndex(body, clientY),
    });
  }

  function clearDragState() {
    dragData = null;
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    document.querySelectorAll('.group-drop-target').forEach(el => el.classList.remove('group-drop-target'));
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
    document.querySelectorAll('.column-drop-indicator').forEach(el => el.remove());
  }

  // --- Keyboard card movement and navigation ---

  function moveCardVertically(task, columnName, delta) {
    const column = board.columns.find(c => c.name === columnName);
    if (!column) return;
    const idx = column.tasks.findIndex(t => t.id === task.id);
    if (idx === -1) return;
    const target = idx + delta;
    if (target < 0 || target >= column.tasks.length) return;

    pendingFocusTaskId = task.id;
    persistState();
    vscode.postMessage({
      type: 'moveTaskToGroup',
      taskId: task.id,
      fromColumn: columnName,
      toColumn: columnName,
      toIndex: target,
      group: task.group || '',
    });
  }

  function moveCardHorizontally(task, columnName, delta) {
    const colIdx = board.columns.findIndex(c => c.name === columnName);
    if (colIdx === -1) return;
    const targetCol = board.columns[colIdx + delta];
    if (!targetCol) return;

    pendingFocusTaskId = task.id;
    persistState();
    vscode.postMessage({
      type: 'moveTaskToGroup',
      taskId: task.id,
      fromColumn: columnName,
      toColumn: targetCol.name,
      toIndex: targetCol.tasks.length,
      group: '',
    });
  }

  // Cards inside a collapsed group are hidden and cannot take focus, so
  // keyboard navigation skips them.
  function visibleCardsIn(columnEl) {
    return Array.from(columnEl.querySelectorAll('.card')).filter(card => card.offsetParent !== null);
  }

  function focusAdjacentCard(currentCard, key) {
    const columnEl = currentCard.closest('.column');
    if (!columnEl) return;

    const currentCards = visibleCardsIn(columnEl);
    const rowIdx = Math.max(0, currentCards.indexOf(currentCard));

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const target = currentCards[rowIdx + (key === 'ArrowDown' ? 1 : -1)];
      if (target) target.focus();
      return;
    }

    // ArrowLeft / ArrowRight: jump to the nearest card in the adjacent column.
    const columns = Array.from(document.querySelectorAll('.board .column'));
    const colPos = columns.indexOf(columnEl);
    const targetCol = columns[colPos + (key === 'ArrowRight' ? 1 : -1)];
    if (!targetCol) return;
    const targetCards = visibleCardsIn(targetCol);
    if (targetCards.length === 0) return;
    targetCards[Math.min(rowIdx, targetCards.length - 1)].focus();
  }

  function getColumnBlocks(boardEl) {
    return Array.from(boardEl.children).filter(child =>
      child.classList.contains('column') && !child.classList.contains('dragging')
    );
  }

  function getColumnDropIndex(boardEl, clientX) {
    const columns = getColumnBlocks(boardEl);
    for (let i = 0; i < columns.length; i++) {
      const rect = columns[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return i;
      }
    }
    return columns.length;
  }

  function updateColumnDropIndicator(boardEl, clientX) {
    removeColumnDropIndicator(boardEl);
    const columns = getColumnBlocks(boardEl);
    const indicator = el('div', 'column-drop-indicator');

    for (let i = 0; i < columns.length; i++) {
      const rect = columns[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        boardEl.insertBefore(indicator, columns[i]);
        return;
      }
    }

    const addColumn = boardEl.querySelector('.add-column-placeholder');
    if (addColumn) {
      boardEl.insertBefore(indicator, addColumn);
    } else {
      boardEl.appendChild(indicator);
    }
  }

  function removeColumnDropIndicator(container) {
    container.querySelectorAll('.column-drop-indicator').forEach(el => el.remove());
  }

  // --- Modals ---

  function openTaskModal(existingTask, columnName, prefillTitle) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');

    const heading = el('h2');
    heading.textContent = existingTask ? 'タスクを編集' : 'タスクを追加';
    modal.appendChild(heading);

    let templateSelect = null;
    if (!existingTask) {
      modal.appendChild(labelEl('テンプレート'));
      templateSelect = document.createElement('select');
      templateSelect.className = 'template-select';
      taskTemplates.forEach(template => {
        const opt = document.createElement('option');
        opt.value = template.id;
        opt.textContent = template.label;
        templateSelect.appendChild(opt);
      });
      modal.appendChild(templateSelect);
    }

    modal.appendChild(labelEl('タイトル'));
    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.value = existingTask ? existingTask.title : (prefillTitle || '');
    titleInput.placeholder = 'タスクのタイトル...';
    modal.appendChild(titleInput);

    modal.appendChild(labelEl('説明'));
    const descInput = el('textarea');
    descInput.rows = 7;
    descInput.value = existingTask ? existingTask.description : '';
    descInput.placeholder = '説明(任意)...\n[設計メモ](docs/design.md) のように書くとリンクになります';
    modal.appendChild(descInput);

    // Assignee & Group row
    const row0 = el('div', 'form-row');

    const assCol = el('div', 'form-col');
    assCol.appendChild(labelEl('担当者'));
    const assigneeInput = el('input');
    assigneeInput.type = 'text';
    assigneeInput.value = existingTask ? (existingTask.assignee || '') : '';
    assigneeInput.placeholder = 'ユーザー名...';
    assCol.appendChild(assigneeInput);
    row0.appendChild(assCol);

    const grpCol = el('div', 'form-col');
    grpCol.appendChild(labelEl('グループ'));
    const groupInput = el('input');
    groupInput.type = 'text';
    groupInput.value = existingTask ? (existingTask.group || '') : '';
    groupInput.placeholder = '例: ログイン, 認証...';
    grpCol.appendChild(groupInput);
    row0.appendChild(grpCol);

    modal.appendChild(row0);

    // Priority & Workload row
    const row1 = el('div', 'form-row');

    const priCol = el('div', 'form-col');
    priCol.appendChild(labelEl('優先度'));
    const priSelect = document.createElement('select');
    [{v:'critical',l:'🔴 緊急'},{v:'high',l:'🟠 高'},{v:'medium',l:'🔵 中'},{v:'low',l:'🟢 低'}].forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.l;
      priSelect.appendChild(opt);
    });
    priSelect.value = existingTask ? (existingTask.priority || 'medium') : 'medium';
    priCol.appendChild(priSelect);
    row1.appendChild(priCol);

    const wlCol = el('div', 'form-col');
    wlCol.appendChild(labelEl('作業量'));
    const wlSelect = document.createElement('select');
    [{v:'easy',l:'🟢 簡単'},{v:'normal',l:'🔵 普通'},{v:'hard',l:'🟠 難しい'},{v:'extreme',l:'🔴 非常に困難'}].forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.l;
      wlSelect.appendChild(opt);
    });
    wlSelect.value = existingTask ? (existingTask.workload || 'normal') : 'normal';
    wlCol.appendChild(wlSelect);
    row1.appendChild(wlCol);

    modal.appendChild(row1);

    // Due date, with shortcuts for the most common relative dates.
    modal.appendChild(labelEl('期限日'));
    const dueDateInput = el('input');
    dueDateInput.type = 'date';
    dueDateInput.value = existingTask ? (existingTask.dueDate || '') : '';
    dueDateInput.style.marginBottom = '6px';
    modal.appendChild(dueDateInput);

    const dueQuick = el('div');
    dueQuick.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;';
    [['今日', 0], ['明日', 1], ['来週', 7]].forEach(([label, offset]) => {
      const btn = el('button', 'secondary');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.cssText = 'padding:3px 10px;font-size:11px;';
      btn.onclick = () => { dueDateInput.value = isoAfterDays(offset); };
      dueQuick.appendChild(btn);
    });
    const clearDue = el('button', 'secondary');
    clearDue.type = 'button';
    clearDue.textContent = 'クリア';
    clearDue.style.cssText = 'padding:3px 10px;font-size:11px;margin-left:auto;';
    clearDue.onclick = () => { dueDateInput.value = ''; };
    dueQuick.appendChild(clearDue);
    modal.appendChild(dueQuick);

    // Recurrence: a new card is created when this one reaches a completed column.
    modal.appendChild(labelEl('繰り返し'));
    const repeatSelect = document.createElement('select');
    [['', 'なし'], ['daily', '毎日'], ['weekly', '毎週'], ['monthly', '毎月'], ['yearly', '毎年']].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      repeatSelect.appendChild(opt);
    });
    repeatSelect.value = existingTask ? (existingTask.repeat || '') : '';
    repeatSelect.title = '完了扱いの列に移動すると、次回分が元の列に作成されます';
    modal.appendChild(repeatSelect);

    // Source is not user-editable in the form, but preserve any existing
    // value (e.g. TODO-import backlinks) so editing a task does not drop it.
    let sourceValue = existingTask ? (existingTask.source || '') : '';

    // Subtasks
    modal.appendChild(labelEl('サブタスク'));
    const subtasksList = el('div', 'subtasks-list');
    let subtasks = existingTask ? (existingTask.subtasks || []).map(s => ({...s})) : [];

    function renderSubtasks() {
      subtasksList.innerHTML = '';
      subtasks.forEach((st, i) => {
        const row = el('div', 'subtask-row');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = st.done;
        cb.onchange = () => { subtasks[i].done = cb.checked; };
        row.appendChild(cb);

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = st.title;
        inp.placeholder = 'サブタスク...';
        inp.oninput = () => { subtasks[i].title = inp.value; };
        row.appendChild(inp);

        const delBtn = el('button', 'danger');
        delBtn.textContent = '✕';
        delBtn.onclick = () => {
          requestConfirmation('deleteSubtask', {
            title: 'サブタスクを削除',
            message: '「' + st.title + '」を削除しますか?',
            confirmText: '削除',
            danger: true,
          }, () => {
            subtasks.splice(i, 1);
            renderSubtasks();
          });
        };
        row.appendChild(delBtn);

        subtasksList.appendChild(row);
      });
    }
    renderSubtasks();
    modal.appendChild(subtasksList);

    const addStBtn = el('button', 'add-subtask-btn');
    addStBtn.textContent = '+ サブタスクを追加';
    addStBtn.onclick = () => {
      subtasks.push({ title: '', done: false });
      renderSubtasks();
      const inputs = subtasksList.querySelectorAll('input[type="text"]');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    };
    modal.appendChild(addStBtn);

    modal.appendChild(labelEl('タグ(カンマ区切り)'));
    const tagsInput = el('input');
    tagsInput.type = 'text';
    tagsInput.value = existingTask ? existingTask.tags.join(', ') : '';
    tagsInput.placeholder = 'bug, feature, urgent';
    tagsInput.style.marginBottom = '6px';
    modal.appendChild(tagsInput);

    // Offer tags already used on this board so they stay consistent.
    const knownTags = getFilterOptions().tags;
    let tagSuggestions = null;
    if (knownTags.length > 0) {
      const hint = el('div');
      hint.textContent = '既存のタグ(クリックで追加/削除)';
      hint.style.cssText = 'font-size:10px;opacity:0.6;margin-bottom:4px;';
      modal.appendChild(hint);

      tagSuggestions = el('div');
      tagSuggestions.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;max-height:96px;overflow-y:auto;';
      modal.appendChild(tagSuggestions);
      tagsInput.addEventListener('input', renderTagSuggestions);
      renderTagSuggestions();
    }

    function parseTagList(value) {
      return value.split(',').map(tag => tag.trim()).filter(Boolean);
    }

    // The text after the last comma is the tag currently being typed.
    function typedTagFragment(value) {
      return value.slice(value.lastIndexOf(',') + 1).trim();
    }

    function renderTagSuggestions() {
      if (!tagSuggestions) return;
      tagSuggestions.innerHTML = '';

      const selected = parseTagList(tagsInput.value);
      const fragment = typedTagFragment(tagsInput.value).toLowerCase();

      for (const tag of knownTags) {
        const isSelected = selected.includes(tag);
        // While typing, narrow the list but always keep chosen tags visible.
        if (!isSelected && fragment && !tag.toLowerCase().includes(fragment)) continue;

        const chip = el('button', 'filter-chip' + (isSelected ? ' active' : ''));
        chip.type = 'button';
        chip.textContent = tag;
        chip.title = isSelected ? 'クリックで削除' : 'クリックで追加';
        chip.onclick = () => {
          const tags = parseTagList(tagsInput.value);
          if (isSelected) {
            tagsInput.value = tags.filter(item => item !== tag).join(', ');
          } else {
            // Replace the partially typed tag with the chosen one.
            const typed = typedTagFragment(tagsInput.value);
            if (typed && tags[tags.length - 1] === typed) tags.pop();
            tags.push(tag);
            tagsInput.value = tags.join(', ');
          }
          renderTagSuggestions();
          tagsInput.focus();
        };
        tagSuggestions.appendChild(chip);
      }
    }

    function applyTaskTemplate(templateId) {
      const template = taskTemplates.find(t => t.id === templateId);
      if (!template) return;
      titleInput.value = template.title || '';
      descInput.value = template.description || '';
      assigneeInput.value = template.assignee || '';
      groupInput.value = '';
      priSelect.value = template.priority || 'medium';
      wlSelect.value = template.workload || 'normal';
      dueDateInput.value = '';
      repeatSelect.value = '';
      sourceValue = '';
      subtasks = (template.subtasks || []).map(st => ({ ...st }));
      tagsInput.value = (template.tags || []).join(', ');
      renderSubtasks();
      renderTagSuggestions();
    }

    if (templateSelect) {
      templateSelect.onchange = () => applyTaskTemplate(templateSelect.value);
    }

    const actions = el('div', 'modal-actions');

    // Destructive/secondary actions on the left (edit mode only)
    if (existingTask) {
      const deleteBtn = el('button', 'danger');
      deleteBtn.type = 'button';
      deleteBtn.textContent = '削除';
      deleteBtn.onclick = () => {
        deleteTask(existingTask, () => overlay.remove());
      };
      actions.appendChild(deleteBtn);

      if (boardConfig.canArchiveCards !== false) {
        const archiveBtn = el('button', 'archive-action');
        archiveBtn.type = 'button';
        archiveBtn.textContent = 'アーカイブ';
        archiveBtn.onclick = () => {
          archiveTask(existingTask, columnName, () => overlay.remove());
        };
        actions.appendChild(archiveBtn);
      }

      if (boardConfig.isArchiveBoard === true) {
        const restoreBtn = el('button', 'secondary');
        restoreBtn.type = 'button';
        restoreBtn.textContent = '復元';
        restoreBtn.onclick = () => {
          restoreTask(existingTask, columnName, () => overlay.remove());
        };
        actions.appendChild(restoreBtn);
      }
    }

    const cancelBtn = el('button', 'secondary');
    cancelBtn.textContent = 'キャンセル';
    // Push cancel/save to the right when left-side actions are present.
    if (existingTask) {
      cancelBtn.style.marginLeft = 'auto';
    }
    cancelBtn.onclick = () => overlay.remove();
    actions.appendChild(cancelBtn);

    const saveBtn = el('button');
    saveBtn.textContent = existingTask ? '保存' : '追加';
    saveBtn.title = 'Ctrl+Enter で保存';
    saveBtn.onclick = () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      const tags = tagsInput.value
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
      const validSubtasks = subtasks.filter(s => s.title.trim().length > 0)
        .map(s => ({ title: s.title.trim(), done: s.done }));

      if (existingTask) {
        vscode.postMessage({
          type: 'editTask',
          taskId: existingTask.id,
          title,
          description: descInput.value.trim(),
          tags,
          priority: priSelect.value,
          workload: wlSelect.value,
          dueDate: dueDateInput.value,
          subtasks: validSubtasks,
          assignee: assigneeInput.value.trim(),
          source: sourceValue,
          group: groupInput.value.trim(),
          repeat: repeatSelect.value,
        });
      } else {
        vscode.postMessage({
          type: 'addTask',
          column: columnName,
          title,
          description: descInput.value.trim(),
          tags,
          priority: priSelect.value,
          workload: wlSelect.value,
          dueDate: dueDateInput.value,
          subtasks: validSubtasks,
          assignee: assigneeInput.value.trim(),
          source: sourceValue,
          group: groupInput.value.trim(),
          repeat: repeatSelect.value,
        });
      }
      overlay.remove();
    };
    actions.appendChild(saveBtn);
    modal.appendChild(actions);

    // Ctrl+Enter (Cmd+Enter on macOS) saves from anywhere in the form,
    // including while typing in the multi-line description field.
    modal.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      }
    });

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setTimeout(() => titleInput.focus(), 50);
  }

  function renameBoard() {
    const newTitle = prompt('ボード名:', board.title);
    if (newTitle && newTitle.trim()) {
      vscode.postMessage({ type: 'updateTitle', title: newTitle.trim() });
      board.title = newTitle.trim();
      render();
    }
  }

  function renameColumn(oldName) {
    const newName = prompt('列名:', oldName);
    if (newName && newName.trim() && newName.trim() !== oldName) {
      vscode.postMessage({ type: 'renameColumn', oldName, newName: newName.trim() });
    }
  }

  function openGroupModal(columnName, oldName) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    const title = el('h2');
    title.textContent = 'グループ名を変更';
    modal.appendChild(title);

    modal.appendChild(labelEl('グループ名'));
    const input = el('input');
    input.type = 'text';
    input.value = oldName;
    input.placeholder = 'グループ名';
    modal.appendChild(input);

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'secondary');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => overlay.remove();
    actions.appendChild(cancelBtn);

    const saveBtn = el('button');
    saveBtn.textContent = '保存';
    saveBtn.type = 'button';
    saveBtn.onclick = () => {
      const newName = input.value.trim();
      if (!newName) {
        input.focus();
        return;
      }
      if (newName !== oldName) {
        vscode.postMessage({ type: 'renameGroup', oldName, newName, column: columnName });
      }
      overlay.remove();
    };
    actions.appendChild(saveBtn);
    modal.appendChild(actions);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      } else if (e.key === 'Escape') {
        overlay.remove();
      }
    });

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  function addColumn(button) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    const title = el('h2');
    title.textContent = '列を追加';
    modal.appendChild(title);

    const field = el('div', 'modal-field');
    const label = labelEl('列名:');
    const input = el('input');
    input.type = 'text';
    input.placeholder = '列名を入力';
    input.style.width = '100%';
    field.appendChild(label);
    field.appendChild(input);
    modal.appendChild(field);

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'secondary');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => overlay.remove();
    actions.appendChild(cancelBtn);

    const addBtn = el('button');
    addBtn.textContent = '列を追加';
    addBtn.type = 'button';
    addBtn.onclick = () => {
      const name = input.value.trim();
      if (!name) {
        alert('列名を空にすることはできません。');
        input.focus();
        return;
      }
      if (board.columns.some(c => c.name === name)) {
        alert('その名前の列は既に存在します。');
        input.focus();
        return;
      }
      board.columns.push({ name, tasks: [] });
      render();
      vscode.postMessage({ type: 'addColumn', name });
      overlay.remove();
    };
    actions.appendChild(addBtn);

    modal.appendChild(actions);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const rect = button.getBoundingClientRect();
    modal.style.position = 'absolute';
    modal.style.top = (Math.min(rect.bottom + 10, window.innerHeight - modal.offsetHeight - 10)) + 'px';
    modal.style.left = (Math.min(rect.left, window.innerWidth - modal.offsetWidth - 10)) + 'px';

    setTimeout(() => input.focus(), 50);
  }

  // --- Helpers ---

  function el(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  function labelEl(text) {
    const l = el('label');
    l.textContent = text;
    return l;
  }

  // Render plain text, turning Markdown links [label](target) and bare http(s)
  // URLs into clickable links. Text is always inserted as text nodes, so no
  // markup from task content is ever parsed as HTML.
  function appendTextWithLinks(container, text) {
    const value = String(text == null ? '' : text);
    const pattern = /\[([^\]\n]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"'`]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(value)) !== null) {
      let label;
      let target;
      let consumed;

      if (match[3]) {
        // Bare URL: trailing punctuation usually belongs to the sentence.
        target = match[3].replace(/[.,;:!?)\]}"'、。，．）］｝」』]+$/, '');
        if (!target) {
          pattern.lastIndex = match.index + match[0].length;
          continue;
        }
        label = target;
        consumed = target.length;
      } else {
        target = match[2];
        label = match[1] || match[2];
        consumed = match[0].length;
      }

      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
      }
      container.appendChild(createLink(label, target));

      lastIndex = match.index + consumed;
      pattern.lastIndex = lastIndex;
    }

    if (lastIndex < value.length) {
      container.appendChild(document.createTextNode(value.slice(lastIndex)));
    }
  }

  function createLink(label, target) {
    const isWebLink = /^https?:\/\//i.test(target);
    const link = document.createElement('a');
    link.href = target;
    link.textContent = label;
    link.title = isWebLink ? target + ' を開く' : target + ' をエディタで開く';
    link.style.cssText = 'color:var(--vscode-textLink-foreground,#3794ff);text-decoration:underline;cursor:pointer;word-break:break-all;';
    link.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isWebLink) {
        vscode.postMessage({ type: 'openExternal', url: target });
      } else {
        vscode.postMessage({ type: 'openFile', path: target });
      }
    };
    return link;
  }

  function isoAfterDays(days) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + days);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
  }

  // Listen for board updates from extension
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'boardUpdate') {
      board = msg.board;
      if (typeof msg.canUndo === 'boolean') canUndo = msg.canUndo;
      render();
    } else if (msg.type === 'openTaskDetails') {
      openTaskDetailsById(msg.taskId);
    } else if (msg.type === 'archiveResult') {
      showNotice(msg.message || (msg.ok ? 'カードをアーカイブしました。' : 'カードをアーカイブできませんでした。'), msg.ok);
    } else if (msg.type === 'notice') {
      showNotice(msg.message, msg.ok !== false);
    }
  });

  function showNotice(message, ok) {
    const existing = document.querySelector('.board-notice');
    if (existing) existing.remove();

    const notice = el('div', 'board-notice' + (ok ? '' : ' error'));
    notice.textContent = message;
    document.body.appendChild(notice);
    window.setTimeout(() => notice.remove(), 3000);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  // Modal keyboard handling: Escape closes the topmost modal, and Tab is
  // trapped within it so focus cannot escape to the board behind.
  document.addEventListener('keydown', (e) => {
    const overlays = document.querySelectorAll('.modal-overlay');
    if (overlays.length === 0) return;
    const overlay = overlays[overlays.length - 1];

    if (e.key === 'Escape') {
      e.preventDefault();
      overlay.remove();
      return;
    }

    if (e.key === 'Tab') {
      const focusable = Array.from(
        overlay.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')
      ).filter(node => !node.disabled && node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // "?" opens the keyboard shortcut cheat sheet from the board (not while
  // typing in a field or when another modal is already open).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(document.activeElement)) return;
    if (document.querySelector('.modal-overlay')) return;
    e.preventDefault();
    openShortcutHelp();
  });

  // Ctrl/Cmd+Z undoes the last board change. Text fields keep their own
  // native undo, so only handle this on the board itself.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'z' && e.key !== 'Z') return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (isTypingTarget(document.activeElement)) return;
    if (document.querySelector('.modal-overlay')) return;
    e.preventDefault();
    requestUndo();
  });

  function isTypingTarget(node) {
    if (!node) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
  }

  // --- Right-button drag panning ---

  // Panning applies to whichever element actually scrolls in each axis; which
  // one that is depends on how the webview lays out the document.
  function panBy(dx, dy) {
    const seen = new Set();
    for (const candidate of [document.scrollingElement, document.body, document.documentElement]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (dx && candidate.scrollWidth > candidate.clientWidth) {
        candidate.scrollLeft += dx;
        dx = 0;
      }
      if (dy && candidate.scrollHeight > candidate.clientHeight) {
        candidate.scrollTop += dy;
        dy = 0;
      }
    }
  }

  function isPannableTarget(target) {
    if (!(target instanceof Element)) return true;
    // Text fields and modals keep their normal right-click behaviour.
    return !isTypingTarget(target) && !target.closest('.modal-overlay');
  }

  (function setupPanning() {
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let previousCursor = '';
    let previousUserSelect = '';

    document.addEventListener('mousedown', (e) => {
      if (e.button !== 2 || !isPannableTarget(e.target)) return;
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      previousCursor = document.body.style.cursor;
      previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!panning) return;
      panBy(lastX - e.clientX, lastY - e.clientY);
      lastX = e.clientX;
      lastY = e.clientY;
      e.preventDefault();
    });

    function stopPanning() {
      if (!panning) return;
      panning = false;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    }

    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) stopPanning();
    });
    document.addEventListener('mouseleave', stopPanning);
    window.addEventListener('blur', stopPanning);

    // The right button is the pan gesture on the board, so suppress the
    // default menu there. Platforms differ on whether contextmenu fires on
    // press or release, so decide from the event target instead of pan state.
    document.addEventListener('contextmenu', (e) => {
      if (isPannableTarget(e.target)) {
        e.preventDefault();
      }
    });
  })();

  function openShortcutHelp() {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal shortcut-help-modal');

    const header = el('div', 'modal-header');
    const heading = el('h2');
    heading.textContent = 'キーボードショートカット';
    header.appendChild(heading);
    const closeBtn = el('button', 'modal-icon-btn');
    closeBtn.textContent = '×';
    closeBtn.title = '閉じる';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const shortcuts = [
      ['Enter / Space', 'カードの編集画面を開く'],
      ['Ctrl+Enter', '編集画面で保存'],
      ['Escape', 'モーダルを閉じる'],
      ['↑ / ↓', '同じ列の前後のカードへフォーカス移動'],
      ['← / →', '隣の列のカードへフォーカス移動'],
      ['Ctrl+↑ / Ctrl+↓', 'カードを列内で並べ替え'],
      ['Ctrl+← / Ctrl+→', 'カードを隣の列へ移動'],
      ['n', 'その列にクイック追加(Enter で連続追加)'],
      ['Ctrl+Z', '直前の操作を元に戻す'],
      ['?', 'このショートカット一覧を表示'],
    ];

    const list = el('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-top:4px;';
    for (const [keys, desc] of shortcuts) {
      const row = el('div');
      row.style.cssText = 'display:flex;gap:12px;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--card-border);';
      const kbd = el('span');
      kbd.textContent = keys;
      kbd.style.cssText = 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;padding:2px 7px;border:1px solid var(--card-border);border-radius:4px;background:var(--input-bg);white-space:nowrap;flex-shrink:0;';
      const d = el('span');
      d.textContent = desc;
      d.style.cssText = 'font-size:12px;opacity:0.85;text-align:right;';
      row.appendChild(kbd);
      row.appendChild(d);
      list.appendChild(row);
    }
    modal.appendChild(list);

    const note = el('div');
    note.textContent = 'macOS では Ctrl の代わりに Cmd(⌘)も使えます。カードは Tab でフォーカスできます。'
      + ' ボード上を右ドラッグすると画面をパン(スクロール)できます。';
    note.style.cssText = 'margin-top:12px;font-size:11px;opacity:0.65;line-height:1.5;';
    modal.appendChild(note);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => closeBtn.focus(), 50);
  }

  // Initial render
  render();
})();
