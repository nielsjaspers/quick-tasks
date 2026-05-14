import {
  AI,
  Action,
  ActionPanel,
  environment,
  getPreferenceValues,
  Form,
  Icon,
  List,
  LocalStorage,
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
  sortKey: number;
};

type Preferences = {
  defaultListName?: string;
  sortOrder?: "newest" | "oldest";
};

type TaskView = "open" | "history";

const execFileAsync = promisify(execFile);
const helperPath = join(environment.assetsPath, "quick-tasks-helper");
const preferences = getPreferenceValues<Preferences>();
const defaultListName = preferences.defaultListName?.trim();
const defaultSortOrder = preferences.sortOrder ?? "newest";
const SORT_ORDER_STORAGE_KEY = "sortOrder";
const REMINDERS_CACHE_KEY_PREFIX = "remindersCache";
const AI_TASK_PREFIX_PATTERN = /^@(ai|agent)\s+/i;

function isSortOrder(value: unknown): value is "newest" | "oldest" {
  return value === "newest" || value === "oldest";
}

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

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function runHelper(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(helperPath, args);
  return stdout.trim();
}

function remindersCacheKey(view: TaskView): string {
  return [REMINDERS_CACHE_KEY_PREFIX, defaultListName || "default", view].join(
    ":",
  );
}

function parseReminders(value: string | undefined): Reminder[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return undefined;
    }

    return parsed
      .filter(
        (reminder): reminder is Reminder =>
          typeof reminder === "object" &&
          reminder !== null &&
          typeof (reminder as Reminder).id === "string" &&
          typeof (reminder as Reminder).title === "string" &&
          typeof (reminder as Reminder).sortKey === "number",
      )
      .map((reminder) => ({
        id: reminder.id,
        title: reminder.title,
        sortKey: reminder.sortKey,
      }));
  } catch {
    return undefined;
  }
}

async function fetchReminders(view: TaskView): Promise<Reminder[]> {
  const command = view === "history" ? "history" : "list";
  const output = await runHelper(
    defaultListName ? [command, defaultListName] : [command],
  );
  return JSON.parse(output || "[]") as Reminder[];
}

async function createReminder(title: string): Promise<void> {
  await runHelper(
    defaultListName ? ["add", title, defaultListName] : ["add", title],
  );
}

async function createReminders(titles: string[]): Promise<void> {
  if (titles.length === 0) {
    throw new Error("No tasks found");
  }

  await Promise.all(titles.map((title) => createReminder(title)));
}

function documentExtractionErrorMessage(error: unknown): string {
  const text = errorText(error);
  const lowerText = text.toLowerCase();

  if (remindersAccessError(error) || remindersListNotFoundError(error)) {
    return reminderErrorMessage(error, "Could not create extracted tasks.");
  }

  if (lowerText.includes("unsupportedfiletype")) {
    return "That file type is not supported yet.";
  }

  if (lowerText.includes("textextractionfailed")) {
    return "Could not read text from that document.";
  }

  if (lowerText.includes("no tasks found")) {
    return "No tasks were found in that document.";
  }

  return `Could not extract tasks from that document: ${text}`;
}

async function completeReminder(id: string): Promise<void> {
  await runHelper(["complete", id]);
}

async function uncompleteReminder(id: string): Promise<void> {
  await runHelper(["uncomplete", id]);
}

async function editReminder(id: string, title: string): Promise<void> {
  await runHelper(["edit", id, title]);
}

function parseExtractedTasks(response: string): string[] {
  try {
    const parsed = JSON.parse(response) as unknown;

    if (Array.isArray(parsed)) {
      return parsed
        .filter((task): task is string => typeof task === "string")
        .map((task) => task.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall back to line parsing below.
  }

  return response
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
}

async function extractTasksWithAI(input: string): Promise<string[]> {
  const request = input.replace(AI_TASK_PREFIX_PATTERN, "").trim();

  const response = await AI.ask(
    [
      "Extract plain task titles from this text.",
      "Return only a JSON array of strings.",
      "Do not include due dates, notes, tags, priorities, or explanations.",
      "Keep each task short and actionable.",
      "",
      request,
    ].join("\n"),
    { creativity: 0 },
  );

  return parseExtractedTasks(response);
}

type EditTaskFormValues = {
  title: string;
};

type DocumentTaskFormValues = {
  files: string[];
  context?: string;
};

async function extractTextFromDocument(filePath: string): Promise<string> {
  return runHelper(["extract-text", filePath]);
}

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

function DocumentTaskForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const { pop } = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(values: DocumentTaskFormValues) {
    const filePath = values.files[0];

    if (!filePath || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      const documentText = await extractTextFromDocument(filePath);
      const response = await AI.ask(
        [
          "Extract plain task titles from this document.",
          "Include tasks, deadlines, action items, things to prepare, things to submit, and follow-ups.",
          "Return only a JSON array of strings.",
          "Do not include explanations.",
          "Do not create due date metadata. If a deadline matters, include it in the task title.",
          "Keep each task short and actionable.",
          "",
          values.context?.trim()
            ? `User context:\n${values.context.trim()}\n`
            : "",
          `Document text:\n${documentText}`,
        ].join("\n"),
        { creativity: 0 },
      );
      const taskTitles = parseExtractedTasks(response);
      await createReminders(taskTitles);
      await onCreated();
      await showToast({
        style: Toast.Style.Success,
        title: `Created ${taskTitles.length} task${taskTitles.length === 1 ? "" : "s"}`,
      });
      pop();
    } catch (caughtError) {
      const message = documentExtractionErrorMessage(caughtError);
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
            title="Extract Tasks"
            icon={Icon.Stars}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="files"
        title="Document"
        allowMultipleSelection={false}
        canChooseDirectories={false}
      />
      <Form.TextArea
        id="context"
        title="Context"
        placeholder="What should the model look for? Any project, course, or deadline context helps."
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
  const [taskView, setTaskView] = useState<TaskView>("open");
  const [error, setError] = useState<string>();

  const hasComposerText = searchText.trim().length > 0;
  const isAIComposerText = AI_TASK_PREFIX_PATTERN.test(searchText);
  const isHistoryMode = taskView === "history";

  const refresh = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading ?? true) {
        setIsLoading(true);
      }

      try {
        const openReminders = await fetchReminders(taskView);
        setReminders(openReminders);
        setError(undefined);
        await LocalStorage.setItem(
          remindersCacheKey(taskView),
          JSON.stringify(openReminders),
        );
        setSelectedItemId(openReminders[0]?.id);
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
    },
    [taskView],
  );

  useEffect(() => {
    async function loadCachedAndRefresh() {
      const cachedReminders = parseReminders(
        await LocalStorage.getItem<string>(remindersCacheKey(taskView)),
      );

      if (cachedReminders) {
        setReminders(cachedReminders);
        setError(undefined);
        setIsLoading(false);
        setSelectedItemId(cachedReminders[0]?.id);
      }

      await refresh({ showLoading: !cachedReminders });
    }

    void loadCachedAndRefresh();
  }, [refresh, taskView]);

  useEffect(() => {
    async function loadStoredSortOrder() {
      const storedSortOrder = await LocalStorage.getItem<string>(
        SORT_ORDER_STORAGE_KEY,
      );

      if (isSortOrder(storedSortOrder)) {
        setSortOrder(storedSortOrder);
      }
    }

    void loadStoredSortOrder();
  }, []);

  const orderedReminders = useMemo(() => {
    return [...reminders].sort((firstReminder, secondReminder) => {
      if (sortOrder === "newest") {
        return secondReminder.sortKey - firstReminder.sortKey;
      }

      return firstReminder.sortKey - secondReminder.sortKey;
    });
  }, [reminders, sortOrder]);

  const visibleReminders = useMemo(() => {
    if ((!isSearchMode && !isHistoryMode) || !hasComposerText) {
      return orderedReminders;
    }

    const normalizedQuery = searchText.toLowerCase();
    return orderedReminders.filter((reminder) =>
      reminder.title.toLowerCase().includes(normalizedQuery),
    );
  }, [
    hasComposerText,
    isHistoryMode,
    isSearchMode,
    orderedReminders,
    searchText,
  ]);

  useEffect(() => {
    setSelectedItemId(visibleReminders[0]?.id);
  }, [visibleReminders]);

  const createFromComposer = useCallback(async () => {
    if (!hasComposerText || isMutating) {
      return;
    }

    setIsMutating(true);
    try {
      if (AI_TASK_PREFIX_PATTERN.test(searchText)) {
        const taskTitles = await extractTasksWithAI(searchText);
        await createReminders(taskTitles);
      } else {
        await createReminder(searchText);
      }
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

  const uncompleteSelected = useCallback(
    async (id: string) => {
      if (isMutating) {
        return;
      }

      setIsMutating(true);
      try {
        await uncompleteReminder(id);
        setReminders((currentReminders) =>
          currentReminders.filter((reminder) => reminder.id !== id),
        );
        setSearchText("");
        await refresh();
      } catch (caughtError) {
        const message = reminderErrorMessage(
          caughtError,
          "Could not restore the reminder.",
        );
        await showToast({ style: Toast.Style.Failure, title: message });
      } finally {
        setIsMutating(false);
      }
    },
    [isMutating, refresh],
  );

  const selectedReminder = visibleReminders.find(
    (reminder) => reminder.id === selectedItemId,
  );

  const createAction = hasComposerText ? (
    <Action
      title={isAIComposerText ? "Extract Tasks with AI" : "Create Task"}
      icon={isAIComposerText ? Icon.Stars : Icon.Plus}
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

  const restoreAction = selectedReminder ? (
    <Action
      title="Restore Task"
      icon={Icon.ArrowCounterClockwise}
      onAction={() => uncompleteSelected(selectedReminder.id)}
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

  const toggleHistoryAction = (
    <Action
      title={isHistoryMode ? "Show Open Tasks" : "Show History"}
      icon={isHistoryMode ? Icon.List : Icon.Clock}
      shortcut={{ modifiers: ["cmd"], key: "y" }}
      onAction={() => {
        setTaskView((currentView) =>
          currentView === "open" ? "history" : "open",
        );
        setSearchText("");
      }}
    />
  );

  const insertAIPrefixAction = (
    <Action
      title="Use AI Task Extraction"
      icon={Icon.Stars}
      shortcut={{ modifiers: ["cmd"], key: "i" }}
      onAction={() => {
        setSearchText((currentText) => {
          if (AI_TASK_PREFIX_PATTERN.test(currentText)) {
            return currentText;
          }

          return currentText ? `@ai ${currentText}` : "@ai ";
        });
      }}
    />
  );

  const extractDocumentTasksAction = (
    <Action.Push
      title="Extract Tasks from Document"
      icon={Icon.Document}
      target={<DocumentTaskForm onCreated={refresh} />}
    />
  );

  const toggleSortOrderAction = (
    <Action
      title={sortOrder === "newest" ? "Sort Oldest First" : "Sort Newest First"}
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd"], key: "b" }}
      onAction={() => {
        setSortOrder((currentSortOrder) => {
          const nextSortOrder =
            currentSortOrder === "newest" ? "oldest" : "newest";
          void LocalStorage.setItem(SORT_ORDER_STORAGE_KEY, nextSortOrder);
          return nextSortOrder;
        });
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
      searchBarPlaceholder={
        isHistoryMode
          ? "Search completed tasks..."
          : isSearchMode
            ? "Search tasks..."
            : "Add a task..."
      }
      searchText={searchText}
      selectedItemId={selectedItemId}
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedItemId(id ?? undefined)}
      filtering={false}
      actions={
        <ActionPanel>
          {isHistoryMode
            ? restoreAction
            : isSearchMode
              ? completeAction
              : createAction}
          {isHistoryMode
            ? undefined
            : isSearchMode
              ? createAction
              : completeAction}
          {!isHistoryMode ? insertAIPrefixAction : undefined}
          {!isHistoryMode ? extractDocumentTasksAction : undefined}
          {toggleHistoryAction}
          {toggleSortOrderAction}
          {!isHistoryMode ? toggleSearchAction : undefined}
        </ActionPanel>
      }
    >
      {error ? (
        <List.EmptyView title={error} />
      ) : (
        <List.Section
          title={
            isAIComposerText
              ? "AI will split this text into plain tasks when you press Enter"
              : undefined
          }
        >
          {visibleReminders.map((reminder) => (
            <List.Item
              key={reminder.id}
              id={reminder.id}
              title={reminder.title}
              icon={isHistoryMode ? Icon.CheckCircle : Icon.Circle}
              actions={
                <ActionPanel>
                  {isHistoryMode ? (
                    <Action
                      title="Restore Task"
                      icon={Icon.ArrowCounterClockwise}
                      onAction={() => uncompleteSelected(reminder.id)}
                    />
                  ) : isSearchMode || !hasComposerText ? (
                    <Action
                      title="Complete Task"
                      icon={Icon.CheckCircle}
                      onAction={() => completeSelected(reminder.id)}
                    />
                  ) : (
                    createAction
                  )}
                  {isHistoryMode ? undefined : isSearchMode ? (
                    createAction
                  ) : hasComposerText ? (
                    <Action
                      title="Complete Selected Task"
                      icon={Icon.CheckCircle}
                      onAction={() => completeSelected(reminder.id)}
                    />
                  ) : undefined}
                  {editAction(reminder)}
                  {!isHistoryMode ? insertAIPrefixAction : undefined}
                  {!isHistoryMode ? extractDocumentTasksAction : undefined}
                  {toggleHistoryAction}
                  {toggleSortOrderAction}
                  {!isHistoryMode ? toggleSearchAction : undefined}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
