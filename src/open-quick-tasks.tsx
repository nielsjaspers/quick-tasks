import {
  Action,
  ActionPanel,
  environment,
  getPreferenceValues,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
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
  sortOrder?: "newest" | "oldest";
};

const execFileAsync = promisify(execFile);
const helperPath = join(environment.assetsPath, "quick-tasks-helper");
const preferences = getPreferenceValues<Preferences>();
const defaultListName = preferences.defaultListName?.trim();
const defaultSortOrder = preferences.sortOrder ?? "newest";

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

async function fetchOpenReminders(
  sortOrder: "newest" | "oldest",
): Promise<Reminder[]> {
  const output = await runHelper(
    defaultListName
      ? ["list", defaultListName, sortOrder]
      : ["list", sortOrder],
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

async function editReminder(id: string, title: string): Promise<void> {
  await runHelper(["edit", id, title]);
}

type EditTaskFormValues = {
  title: string;
};

function EditTaskForm({
  reminder,
  onEdited,
}: {
  reminder: Reminder;
  onEdited: () => Promise<void>;
}) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState(reminder.title);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(values: EditTaskFormValues) {
    const nextTitle = values.title.trim();

    if (!nextTitle || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      await editReminder(reminder.id, nextTitle);
      await onEdited();
      pop();
    } catch (caughtError) {
      const message = reminderErrorMessage(
        caughtError,
        "Could not edit the reminder.",
      );
      await showToast({ style: Toast.Style.Failure, title: message });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form
      isLoading={isSubmitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Task"
            icon={Icon.Check}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Task"
        value={title}
        onChange={setTitle}
        autoFocus
      />
    </Form>
  );
}

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">(
    defaultSortOrder,
  );
  const [error, setError] = useState<string>();

  const hasComposerText = searchText.trim().length > 0;

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const openReminders = await fetchOpenReminders(sortOrder);
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
  }, [sortOrder]);

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

  const toggleSortOrderAction = (
    <Action
      title={sortOrder === "newest" ? "Sort Oldest First" : "Sort Newest First"}
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd"], key: "b" }}
      onAction={() => {
        setSortOrder((currentSortOrder) =>
          currentSortOrder === "newest" ? "oldest" : "newest",
        );
      }}
    />
  );

  const editAction = (reminder: Reminder) => (
    <Action.Push
      title="Edit Task"
      icon={Icon.Pencil}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      target={<EditTaskForm reminder={reminder} onEdited={refresh} />}
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
          {toggleSortOrderAction}
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
                {isSearchMode || !hasComposerText ? (
                  <Action
                    title="Complete Task"
                    icon={Icon.CheckCircle}
                    onAction={() => completeSelected(reminder.id)}
                  />
                ) : (
                  createAction
                )}
                {isSearchMode ? (
                  createAction
                ) : hasComposerText ? (
                  <Action
                    title="Complete Selected Task"
                    icon={Icon.CheckCircle}
                    onAction={() => completeSelected(reminder.id)}
                  />
                ) : undefined}
                {editAction(reminder)}
                {toggleSortOrderAction}
                {toggleSearchAction}
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
