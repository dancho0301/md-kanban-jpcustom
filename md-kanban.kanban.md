<!-- This is a Kanban Board file created with MD Kanban extension -->
<!-- GitHub: https://github.com/jebakumarj/md-kanban -->
<!-- VS Code Extension: Search "MD Kanban" in the extension store (ID: jeddak.md-kanban) -->

# Md Kanban Board

## To Do

## In Progress

## Done

#### Show timeline as collapsible tree
Updated Calendar timeline mode to show upcoming due cards in compact collapsible groups instead of card-style sections. Timeline items still open the source board and selected card details.
Tags: `calendar` `timeline` `ux`

#### Add TODO scanning settings
Make TODO keywords and include/exclude globs configurable, with support for labels like FIXME, BUG, HACK, and NOTE.
Tags: `settings` `todo`

#### Add parser and serializer tests
Cover Markdown parsing and round-trip serialization for groups, metadata, tags, subtasks, ordering, and edge cases.
Tags: `tests` `quality`
<!-- priority: high -->
<!-- workload: hard -->

#### Add overdue task reminders
Surface overdue cards in a command, tree view, or Problems-style list so time-sensitive work is easier to notice.
Tags: `due-date` `notifications`
<!-- priority: low -->

#### Add board and task templates
Provide reusable board templates such as Sprint, Bug Tracker, Release Checklist, and Personal, plus optional task templates.
Tags: `templates` `onboarding`

#### Show board statistics
Display card counts, overdue counts, workload totals, and subtask completion progress in a compact board summary.
Tags: `analytics` `ux`

#### Convert TODO comments to Kanban tasks
Add an action in the TODO side panel to create a card from a source TODO. Let the user choose the target board and column, and include the source file and line as a backlink.
Tags: `todo` `workflow`
<!-- priority: critical -->
<!-- workload: hard -->

#### Add board filters and search
Filter visible cards by text, tag, assignee, priority, workload, due date, and overdue status.
Tags: `ux` `search`
<!-- priority: high -->

#### Archive completed tasks
Add a command to move old completed cards out of the active board while preserving history in Markdown.
Tags: `cleanup` `markdown`

#### Link cards to source files
Support card metadata for source references such as `src/file.ts:42`, and open the referenced file from the card UI.
Tags: `source` `navigation`
<!-- priority: high -->
