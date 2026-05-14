import EventKit
import Foundation

enum QuickTasksError: Error {
  case missingCommand
  case missingTitle
  case missingIdentifier
  case remindersAccessDenied
  case noDefaultList
  case listNotFound(String)
  case reminderNotFound
}

struct ReminderOutput: Encodable {
  let id: String
  let title: String
}

enum SortOrder: String {
  case newest
  case oldest
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

func reminderCalendar(named listName: String?) throws -> EKCalendar {
  if let listName, !listName.isEmpty {
    guard let calendar = store
      .calendars(for: .reminder)
      .first(where: { $0.title == listName }) else {
      throw QuickTasksError.listNotFound(listName)
    }

    return calendar
  }

  guard let defaultCalendar = store.defaultCalendarForNewReminders() else {
    throw QuickTasksError.noDefaultList
  }

  return defaultCalendar
}

func incompleteReminders(listName: String?) throws -> [EKReminder] {
  try requestRemindersAccess()

  let calendar = try reminderCalendar(named: listName)
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

func listReminders(listName: String?, sortOrder: SortOrder) throws {
  let reminders = try incompleteReminders(listName: listName)
    .sorted { first, second in
      let firstDate = first.creationDate ?? Date.distantPast
      let secondDate = second.creationDate ?? Date.distantPast

      switch sortOrder {
      case .newest:
        return firstDate > secondDate
      case .oldest:
        return firstDate < secondDate
      }
    }
    .map { reminder in
      ReminderOutput(id: reminder.calendarItemIdentifier, title: reminder.title ?? "")
    }

  let data = try JSONEncoder().encode(reminders)
  print(String(data: data, encoding: .utf8) ?? "[]")
}

func listArguments(_ arguments: [String]) -> (String?, SortOrder) {
  let sortValues = Set([SortOrder.newest.rawValue, SortOrder.oldest.rawValue])

  if arguments.count >= 4 {
    return (arguments[2], SortOrder(rawValue: arguments[3]) ?? .newest)
  }

  if arguments.count >= 3 {
    if sortValues.contains(arguments[2]) {
      return (nil, SortOrder(rawValue: arguments[2]) ?? .newest)
    }

    return (arguments[2], .newest)
  }

  return (nil, .newest)
}

func addReminder(title: String, listName: String?) throws {
  try requestRemindersAccess()

  let reminder = EKReminder(eventStore: store)
  reminder.calendar = try reminderCalendar(named: listName)
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

func editReminder(id: String, title: String) throws {
  try requestRemindersAccess()

  guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
    throw QuickTasksError.reminderNotFound
  }

  reminder.title = title
  try store.save(reminder, commit: true)
}

do {
  let arguments = CommandLine.arguments

  guard arguments.count >= 2 else {
    throw QuickTasksError.missingCommand
  }

  switch arguments[1] {
  case "list":
    let (listName, sortOrder) = listArguments(arguments)
    try listReminders(listName: listName, sortOrder: sortOrder)
  case "add":
    guard arguments.count >= 3 else {
      throw QuickTasksError.missingTitle
    }
    let listName = arguments.count >= 4 ? arguments[3] : nil
    try addReminder(title: arguments[2], listName: listName)
  case "complete":
    guard arguments.count >= 3 else {
      throw QuickTasksError.missingIdentifier
    }
    try completeReminder(id: arguments[2])
  case "edit":
    guard arguments.count >= 4 else {
      throw QuickTasksError.missingTitle
    }
    try editReminder(id: arguments[2], title: arguments[3])
  default:
    throw QuickTasksError.missingCommand
  }
} catch {
  fputs("quick-tasks-helper: \(error)\n", stderr)
  exit(1)
}
