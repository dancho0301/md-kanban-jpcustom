# MD Kanban

A VS Code extension that lets you manage project tasks and todos in a visual Kanban board — with all data stored as readable Markdown files. Human-readable, diffable, and version-control friendly.

![VS Code](https://img.shields.io/badge/VS%20Code-v1.109%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Visual Kanban Board** — Drag-and-drop task cards between columns right inside VS Code
- **Markdown Storage** — All board data is saved as `.kanban.md` files — human-readable, diffable, and Git-friendly
- **Task Details** — Title, description, tags, priority, workload, due date, assignee, and subtasks
- **Priority Levels** — Critical, High, Medium, Low — with color-coded visual strips on cards
- **Workload Badges** — Easy, Normal, Hard, Extreme — to estimate effort at a glance
- **Due Dates** — Set deadlines with a date picker; overdue tasks highlighted automatically
- **Subtasks** — Break tasks into checkable sub-items with progress tracking
- **Task Groups** — Organize tasks within a column using collapsible groups (`###` headings in Markdown)
- **Drag-and-Drop Grouping** — Drag cards into or out of groups to reassign
- **Column Management** — Add, rename, reorder, and remove columns to fit your workflow
- **Theme Integration** — Automatically matches your VS Code color theme (light, dark, high contrast)
- **Live Sync** — Watches the file for external changes and refreshes the board in real time
- **Side-by-Side Markdown** — Open the raw `.kanban.md` file alongside the board for manual editing

## Quick Start

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **Kanban: Create New Kanban Board**
3. Enter a name — a `.kanban.md` file is created with default columns
4. Start adding tasks!

| Command | Description |
|---------|-------------|
| `Kanban: Create New Kanban Board` | Create a new `.kanban.md` file with default columns |
| `Kanban: Open Kanban Board` | Open an existing `.kanban.md` file as a Kanban board |

## Markdown Format

Board data is stored in plain Markdown. You can edit it by hand or with the visual board — both stay in sync.

```markdown
# My Project Board

## To Do

#### Set up database migrations

<!-- priority: high -->
<!-- workload: hard -->
<!-- due: 2026-04-01 -->
<!-- assignee: Alice -->

Create migration scripts for PostgreSQL schema changes

- [x] Design schema
- [ ] Write migration files
- [ ] Add rollback scripts

`backend` `database`

### Sprint 1

#### Implement user auth

<!-- priority: critical -->
<!-- assignee: Bob -->

Add OAuth2 support for Google and GitHub

`feature` `auth`

#### Fix mobile layout

<!-- priority: high -->
<!-- workload: easy -->

Navbar overlaps content on small screens

`bug` `frontend`

## In Progress

#### Write API docs

`docs`

## Done

#### Set up CI/CD pipeline

Configured GitHub Actions for build and deploy

`devops`
```

### Heading Structure

| Heading | Meaning |
|---------|---------|
| `#`     | Board title |
| `##`    | Column |
| `###`   | Task group (optional) |
| `####`  | Task |

### Task Metadata (HTML comments)

| Comment | Values |
|---------|--------|
| `<!-- priority: VALUE -->` | `critical`, `high`, `medium`, `low` |
| `<!-- workload: VALUE -->` | `easy`, `normal`, `hard`, `extreme` |
| `<!-- due: YYYY-MM-DD -->`  | Any valid date |
| `<!-- assignee: NAME -->`  | Free text |

- **Subtasks**: `- [x] Done item` / `- [ ] Pending item`
- **Tags**: `` `tag-name` `` (backtick-wrapped, on their own line)
- **Description**: Plain text lines below the task heading

## Usage

### Tasks

- Click **+ Add Task** at the bottom of any column to create a new task
- Fill in title, description, tags, priority, workload, due date, assignee, and subtasks
- Hover over a card to reveal **edit** (✎) and **delete** (✕) buttons
- **Drag and drop** cards between columns, within a column, or into/out of groups

### Groups

- Tasks under a `###` heading belong to that group
- Groups render as collapsible sections in the board
- Click a group header to collapse/expand
- Click the edit icon on a group header to rename it
- Drag cards into a group to assign them; drag to the ungrouped zone to remove

### Columns

- Click **+ Add Column** to add a new column
- Click a column title to rename it
- Click **✕** on the column header to delete it (tasks will be lost)

### Board

- Click the board title in the toolbar to rename it
- Click **📄 View Markdown** to open the raw file side-by-side

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) v16+
- [VS Code](https://code.visualstudio.com/) v1.109+

### Setup

```bash
git clone https://github.com/your-username/md-kanban.git
cd md-kanban
npm install
npm run compile
```

### Run & Debug

Press **F5** to launch the Extension Development Host with the extension loaded.

### Project Structure

```
md-kanban/
├── src/
│   ├── extension.ts        # Extension entry point & commands
│   ├── kanbanPanel.ts       # Webview panel lifecycle & message handlers
│   ├── kanbanParser.ts      # Markdown ↔ KanbanBoard parser/serializer
│   └── webviewContent.ts    # Full HTML/CSS/JS for the Kanban UI
├── out/                     # Compiled JS output
├── package.json             # Extension manifest
├── tsconfig.json            # TypeScript config
└── README.md
```

## Publishing

### Prerequisites

1. Install the VS Code Extension CLI:
   ```bash
   npm install -g @vscode/vsce
   ```
2. Create a publisher account on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage).
3. Generate a Personal Access Token (PAT) in [Azure DevOps](https://dev.azure.com/) with the **Marketplace (Manage)** scope.

### Steps

1. **Update `package.json`** — set `publisher` to your Marketplace publisher ID, verify `version`, `repository`, and `icon` fields.

2. **Login to your publisher**:
   ```bash
   vsce login your-publisher-id
   ```

3. **Package the extension** (creates a `.vsix` file):
   ```bash
   vsce package
   ```

4. **Test locally** — install the `.vsix` in VS Code:
   - Command Palette → **Extensions: Install from VSIX...**
   - Verify all features work

5. **Publish**:
   ```bash
   vsce publish
   ```
   Or publish with a version bump:
   ```bash
   vsce publish minor
   ```

### Production Checklist

- [ ] Set a real `publisher` ID in `package.json`
- [ ] Add an extension icon (128x128 PNG) and set the `icon` field
- [ ] Add a `repository` URL in `package.json`
- [ ] Review `CHANGELOG.md` entries
- [ ] Verify `.vscodeignore` excludes source files and dev artifacts
- [ ] Test the packaged `.vsix` in a clean VS Code instance
- [ ] Confirm all commands work from the Command Palette
- [ ] Test with light, dark, and high-contrast themes

## License

MIT
