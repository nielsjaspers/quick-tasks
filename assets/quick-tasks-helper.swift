import EventKit
import Foundation

enum QuickTasksError: Error {
  case missingCommand
  case missingTitle
  case missingIdentifier
  case remindersAccessDenied
  case noDefaultList
  case reminderNotFound
}

struct ReminderOutput: Encodable {
  let id: String
  let title: String
}

let store = EKEventStore()

func requestRemindersAccess() throws {
  let semaphore = DispatchSemaphore(value: 0)
  var grantedAccess = false
  var requestError: Error?

  if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { granted, error in
      grantedAccess = granted
      requestError = error
      semaphore.signal()
    }
  } else {
    store.requestAccess(to: .reminder) { granted, error in
      grantedAccess = granted
      requestError = error
      semaphore.signal()
    }
  }

  semaphore.wait()

  if let requestError {
    throw requestError
  }

  if !grantedAccess {
    throw QuickTasksError.remindersAccessDenied
  }
}

func defaultReminderCalendar() throws -> EKCalendar {
  guard let calendar = store.defaultCalendarForNewReminders() else {
    throw QuickTasksError.noDefaultList
  }

  return calendar
}

func incompleteReminders() throws -> [EKReminder] {
  try requestRemindersAccess()

  let calendar = try defaultReminderCalendar()
  let predicate = store.predicateForIncompleteReminders(
    withDueDateStarting: nil,
    ending: nil,
    calendars: [calendar]
  )

  let semaphore = DispatchSemaphore(value: 0)
  var fetchedReminders: [EKReminder]?

  store.fetchReminders(matching: predicate) { reminders in
    fetchedReminders = reminders
    semaphore.signal()
  }

  semaphore.wait()

  return fetchedReminders ?? []
}

func listReminders() throws {
  let reminders = try incompleteReminders()
    .sorted { first, second in
      let firstDate = first.creationDate ?? Date.distantPast
      let secondDate = second.creationDate ?? Date.distantPast
      return firstDate > secondDate
    }
    .map { reminder in
      ReminderOutput(id: reminder.calendarItemIdentifier, title: reminder.title ?? "")
    }

  let data = try JSONEncoder().encode(reminders)
  print(String(data: data, encoding: .utf8) ?? "[]")
}

func addReminder(title: String) throws {
  try requestRemindersAccess()

  let reminder = EKReminder(eventStore: store)
  reminder.calendar = try defaultReminderCalendar()
  reminder.title = title

  try store.save(reminder, commit: true)
}

func completeReminder(id: String) throws {
  try requestRemindersAccess()

  guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
    throw QuickTasksError.reminderNotFound
  }

  reminder.isCompleted = true
  try store.save(reminder, commit: true)
}

do {
  let arguments = CommandLine.arguments

  guard arguments.count >= 2 else {
    throw QuickTasksError.missingCommand
  }

  switch arguments[1] {
  case "list":
    try listReminders()
  case "add":
    guard arguments.count >= 3 else {
      throw QuickTasksError.missingTitle
    }
    try addReminder(title: arguments[2])
  case "complete":
    guard arguments.count >= 3 else {
      throw QuickTasksError.missingIdentifier
    }
    try completeReminder(id: arguments[2])
  default:
    throw QuickTasksError.missingCommand
  }
} catch {
  fputs("quick-tasks-helper: \(error)\n", stderr)
  exit(1)
}
