import {
  Action,
  ActionPanel,
  environment,
  getPreferenceValues,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { execFile } from "child_process";
import { join } from "path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { promisify } from "util";

type Reminder = {
  id: string;
  title: string;
};

type Preferences = {
  defaultListName?: string;
};

const execFileAsync = promisify(execFile);
const helperPath = join(environment.assetsPath, "quick-tasks-helper");
const preferences = getPreferenceValues<Preferences>();
const defaultListName = preferences.defaultListName?.trim();

function remindersAccessError(error: unknown): boolean {
  return (
    String(error).toLowerCase().includes("denied") ||
    String(error).toLowerCase().includes("not authorized") ||
    String(error).toLowerCase().includes("not permitted") ||
    String(error).toLowerCase().includes("remindersaccessdenied")
  );
}

function remindersListNotFoundError(error: unknown): boolean {
  return String(error).toLowerCase().includes("listnotfound");
}

function reminderErrorMessage(error: unknown, fallback: string): string {
  if (remindersAccessError(error)) {
    return "Quick Tasks needs access to Apple Reminders to work.";
  }

  if (remindersListNotFoundError(error)) {
    return "Quick Tasks could not find that Reminders list.";
  }

  return fallback;
}

async function runHelper(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(helperPath, args);
  return stdout.trim();
}

async function fetchOpenReminders(): Promise<Reminder[]> {
  const output = await runHelper(
    defaultListName ? ["list", defaultListName] : ["list"],
  );
  return JSON.parse(output || "[]") as Reminder[];
}

async function createReminder(title: string): Promise<void> {
  await runHelper(
    defaultListName ? ["add", title, defaultListName] : ["add", title],
  );
}

async function completeReminder(id: string): Promise<void> {
  await runHelper(["complete", id]);
}

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [error, setError] = useState<string>();

  const hasComposerText = searchText.trim().length > 0;

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const openReminders = await fetchOpenReminders();
      setReminders(openReminders);
      setError(undefined);
      setSelectedItemId((currentId) => {
        if (
          currentId &&
          openReminders.some((reminder) => reminder.id === currentId)
        ) {
          return currentId;
        }

        return openReminders[0]?.id;
      });
    } catch (caughtError) {
      const message = reminderErrorMessage(
        caughtError,
        "Could not read Apple Reminders.",
      );
      setError(message);
      setReminders([]);
      await showToast({ style: Toast.Style.Failure, title: message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleReminders = useMemo(() => {
    if (!isSearchMode || !hasComposerText) {
      return reminders;
    }

    const normalizedQuery = searchText.toLowerCase();
    return reminders.filter((reminder) =>
      reminder.title.toLowerCase().includes(normalizedQuery),
    );
  }, [hasComposerText, isSearchMode, reminders, searchText]);

  const createFromComposer = useCallback(async () => {
    if (!hasComposerText || isMutating) {
      return;
    }

    setIsMutating(true);
    try {
      await createReminder(searchText);
      setSearchText("");
      await refresh();
    } catch (caughtError) {
      const message = reminderErrorMessage(
        caughtError,
        "Could not create the reminder.",
      );
      await showToast({ style: Toast.Style.Failure, title: message });
    } finally {
      setIsMutating(false);
    }
  }, [hasComposerText, isMutating, refresh, searchText]);

  const completeSelected = useCallback(
    async (id: string) => {
      if (isMutating) {
        return;
      }

      setIsMutating(true);
      try {
        await completeReminder(id);
        setReminders((currentReminders) =>
          currentReminders.filter((reminder) => reminder.id !== id),
        );
        if (isSearchMode) {
          setSearchText("");
        }
        await refresh();
      } catch (caughtError) {
        const message = reminderErrorMessage(
          caughtError,
          "Could not complete the reminder.",
        );
        await showToast({ style: Toast.Style.Failure, title: message });
      } finally {
        setIsMutating(false);
      }
    },
    [isMutating, isSearchMode, refresh],
  );

  const selectedReminder = visibleReminders.find(
    (reminder) => reminder.id === selectedItemId,
  );

  const createAction = hasComposerText ? (
    <Action
      title="Create Task"
      icon={Icon.Plus}
      onAction={createFromComposer}
    />
  ) : undefined;

  const completeAction = selectedReminder ? (
    <Action
      title="Complete Task"
      icon={Icon.CheckCircle}
      onAction={() => completeSelected(selectedReminder.id)}
    />
  ) : undefined;

  const toggleSearchAction = (
    <Action
      title={isSearchMode ? "Use Composer" : "Search Tasks"}
      icon={Icon.MagnifyingGlass}
      shortcut={{ modifiers: ["cmd"], key: "f" }}
      onAction={() => {
        setIsSearchMode((currentMode) => !currentMode);
        setSearchText("");
      }}
    />
  );

  return (
    <List
      isLoading={isLoading || isMutating}
      searchBarPlaceholder={isSearchMode ? "Search tasks..." : "Add a task..."}
      searchText={searchText}
      selectedItemId={selectedItemId}
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedItemId(id ?? undefined)}
      filtering={false}
      actions={
        <ActionPanel>
          {isSearchMode ? completeAction : createAction}
          {isSearchMode ? createAction : completeAction}
          {toggleSearchAction}
        </ActionPanel>
      }
    >
      {error ? (
        <List.EmptyView title={error} />
      ) : (
        visibleReminders.map((reminder) => (
          <List.Item
            key={reminder.id}
            id={reminder.id}
            title={reminder.title}
            icon={Icon.Circle}
            actions={
              <ActionPanel>
                <Action
                  title="Complete Task"
                  icon={Icon.CheckCircle}
                  onAction={() => completeSelected(reminder.id)}
                />
                {isSearchMode ? (
                  createAction
                ) : (
                  <Action
                    title="Complete Selected Task"
                    icon={Icon.CheckCircle}
                    onAction={() => completeSelected(reminder.id)}
                  />
                )}
                {toggleSearchAction}
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
