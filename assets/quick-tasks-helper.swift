import EventKit
import Foundation
import PDFKit
import Vision
#if canImport(AppKit)
import AppKit
#endif

enum QuickTasksError: Error {
  case missingCommand
  case missingTitle
  case missingIdentifier
  case missingFilePath
  case unsupportedFileType(String)
  case remindersAccessDenied
  case noDefaultList
  case listNotFound(String)
  case reminderNotFound
  case textExtractionFailed
}

struct ReminderOutput: Encodable {
  let id: String
  let title: String
  let sortKey: Double
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

func completedReminders(listName: String?) throws -> [EKReminder] {
  try requestRemindersAccess()

  let calendar = try reminderCalendar(named: listName)
  let predicate = store.predicateForCompletedReminders(
    withCompletionDateStarting: nil,
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

func reminderSortKey(_ reminder: EKReminder, completed: Bool) -> Double {
  let date = (completed ? reminder.completionDate : reminder.creationDate) ?? reminder.creationDate ?? Date.distantPast
  return date.timeIntervalSince1970
}

func listReminders(listName: String?, sortOrder: SortOrder, completed: Bool) throws {
  let reminders = try (completed ? completedReminders(listName: listName) : incompleteReminders(listName: listName))
    .sorted { first, second in
      let firstSortKey = reminderSortKey(first, completed: completed)
      let secondSortKey = reminderSortKey(second, completed: completed)

      switch sortOrder {
      case .newest:
        return firstSortKey > secondSortKey
      case .oldest:
        return firstSortKey < secondSortKey
      }
    }
    .map { reminder in
      ReminderOutput(
        id: reminder.calendarItemIdentifier,
        title: reminder.title ?? "",
        sortKey: reminderSortKey(reminder, completed: completed)
      )
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

func uncompleteReminder(id: String) throws {
  try requestRemindersAccess()

  guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
    throw QuickTasksError.reminderNotFound
  }

  reminder.isCompleted = false
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

func textFromPlainFile(url: URL) throws -> String {
  return try String(contentsOf: url, encoding: .utf8)
}

func textFromHTML(url: URL) throws -> String {
  let data = try Data(contentsOf: url)
  let attributedString = try NSAttributedString(
    data: data,
    options: [
      .documentType: NSAttributedString.DocumentType.html,
      .characterEncoding: String.Encoding.utf8.rawValue
    ],
    documentAttributes: nil
  )

  return attributedString.string
}

func recognizedText(cgImage: CGImage) throws -> String {
#if canImport(AppKit)
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true

  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])

  return (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")
#else
  throw QuickTasksError.textExtractionFailed
#endif
}

func cgImage(from image: NSImage) throws -> CGImage {
  guard
    let tiffData = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiffData),
    let cgImage = bitmap.cgImage
  else {
    throw QuickTasksError.textExtractionFailed
  }

  return cgImage
}

func textFromPDF(url: URL) throws -> String {
  guard let document = PDFDocument(url: url) else {
    throw QuickTasksError.textExtractionFailed
  }

  var pageTexts: [String] = []

  for pageIndex in 0..<document.pageCount {
    guard let page = document.page(at: pageIndex) else {
      continue
    }

    if let pageText = page.string?.trimmingCharacters(in: .whitespacesAndNewlines), !pageText.isEmpty {
      pageTexts.append(pageText)
      continue
    }

    let thumbnail = page.thumbnail(of: CGSize(width: 1800, height: 2400), for: .mediaBox)
    let ocrText = try recognizedText(cgImage: cgImage(from: thumbnail))

    if !ocrText.isEmpty {
      pageTexts.append(ocrText)
    }
  }

  return pageTexts.joined(separator: "\n\n")
}

func textFromImage(url: URL) throws -> String {
  guard let image = NSImage(contentsOf: url) else {
    throw QuickTasksError.textExtractionFailed
  }

  return try recognizedText(cgImage: cgImage(from: image))
}

func extractText(filePath: String) throws {
  let url = URL(fileURLWithPath: filePath)
  let fileExtension = url.pathExtension.lowercased()
  let plainTextExtensions = Set([
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "rtf", "log"
  ])
  let htmlExtensions = Set(["html", "htm"])
  let imageExtensions = Set(["png", "jpg", "jpeg", "heic", "tif", "tiff", "bmp", "gif"])

  let text: String

  if plainTextExtensions.contains(fileExtension) {
    text = try textFromPlainFile(url: url)
  } else if htmlExtensions.contains(fileExtension) {
    text = try textFromHTML(url: url)
  } else if fileExtension == "pdf" {
    text = try textFromPDF(url: url)
  } else if imageExtensions.contains(fileExtension) {
    text = try textFromImage(url: url)
  } else {
    throw QuickTasksError.unsupportedFileType(fileExtension)
  }

  print(text)
}

do {
  let arguments = CommandLine.arguments

  guard arguments.count >= 2 else {
    throw QuickTasksError.missingCommand
  }

  switch arguments[1] {
  case "list":
    let (listName, sortOrder) = listArguments(arguments)
    try listReminders(listName: listName, sortOrder: sortOrder, completed: false)
  case "history":
    let (listName, sortOrder) = listArguments(arguments)
    try listReminders(listName: listName, sortOrder: sortOrder, completed: true)
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
  case "uncomplete":
    guard arguments.count >= 3 else {
      throw QuickTasksError.missingIdentifier
    }
    try uncompleteReminder(id: arguments[2])
  case "edit":
    guard arguments.count >= 4 else {
      throw QuickTasksError.missingTitle
    }
    try editReminder(id: arguments[2], title: arguments[3])
  case "extract-text":
    guard arguments.count >= 3 else {
      throw QuickTasksError.missingFilePath
    }
    try extractText(filePath: arguments[2])
  default:
    throw QuickTasksError.missingCommand
  }
} catch {
  fputs("quick-tasks-helper: \(error)\n", stderr)
  exit(1)
}
