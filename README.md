# Quick Tasks

Quick Tasks is a minimal Raycast extension for Apple Reminders. It is built for fast capture, completion, and quick recall, closer to a tiny task inbox than a full reminders manager.

The extension has one command: `Quick Tasks`.

## How It Works

Open the command and type into the search bar.

By default, the bar is a composer. Typing does not filter the list. Press `Enter` with text in the composer to create a new reminder. The input clears after creation, the list refreshes, and you can type the next task immediately.

The list shows incomplete reminders only. Selecting a task and pressing `Enter` completes it in Apple Reminders, then removes it from the list.

Press `Cmd+F` to switch into search mode. In search mode, typing filters the open tasks. Press `Enter` to complete the selected task. The create action is still available from the action panel when you want to turn the current text into a task instead of completing the selected one.

Press `Cmd+Y` to switch to history. History shows completed reminders, supports search, and lets you restore a completed reminder back to open with `Enter`.

Press `Cmd+R` on a selected reminder to edit its title.

Press `Cmd+B` to toggle between newest first and oldest first. Quick Tasks remembers the last sort order you used.

Press `Cmd+I` to insert `@ai ` into the composer when you want AI to split a longer prompt into multiple tasks.

## Reminders List

Quick Tasks uses Apple Reminders as the source of truth. It does not keep its own task database.

By default, new tasks go to the Apple Reminders default list. You can change this in Raycast extension settings:

- `Default List Name`: optional exact Apple Reminders list name
- `Sort Order`: initial order for reminders, newest first or oldest first

Leave it blank to keep using the Reminders default list.

## AI Capture

If a composer line starts with `@ai` or `@agent`, Quick Tasks asks Raycast AI to split the text into plain task titles and creates them as separate reminders.

## Development

This project uses Bun for the JavaScript and TypeScript workflow.

```sh
bun run dev
```

The extension uses a small Swift helper for Apple Reminders access through EventKit. The helper is compiled before development and build commands:

```sh
bun run compile-helper
bun run build
```

Useful commands:

```sh
bun run lint
bun run fix-lint
bun run build
```

## Permissions

macOS must allow the extension to access Reminders. If access is missing, Quick Tasks cannot read, create, or complete tasks.
