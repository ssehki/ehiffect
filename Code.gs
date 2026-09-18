/**
 * EHIFFECT BOOKING BACKEND
 * ------------------------
 * 1. Go to sheets.google.com → create a new blank Sheet. Name it "Ehiffect Bookings".
 * 2. Extensions → Apps Script. Delete the placeholder code and paste this whole file in.
 * 3. Change NOTIFY_EMAIL below to your real email (the one your phone's Gmail app is signed into).
 * 4. Click Deploy → New deployment → gear icon → "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Click Deploy, authorize when Google asks (click Advanced → Go to project (unsafe) — this is
 *    just Google being cautious about your own script, it's fine).
 * 6. Copy the Web App URL it gives you — that's what goes into CONFIG.apiUrl in index.html.
 * 7. Run formatSheet() once (see its own instructions below) — this also backfills any new
 *    column headers and locks the date/time columns as plain text so Sheets stops
 *    auto-converting them into its own confusing date/time values.
 *
 * NOTE: everything runs through doGet (not doPost). Apps Script's /exec endpoint does an
 * internal redirect, and browsers silently convert POST -> GET when following that redirect —
 * so POST from an external site like GitHub Pages never reliably reaches doPost. GET survives
 * the redirect correctly every time, so all actions (list/create/updateStatus/checkVisits) go
 * through it.
 */

const NOTIFY_EMAIL = "ehivoltk@gmail.com"; // <-- CHANGE THIS
const PHOTO_FOLDER_NAME = "Ehiffect Booking Photos";

// Every Nth approved visit from the same phone number gets flagged for a surprise
// internal loyalty gift. Change this one number any time — nothing else to touch.
const LOYALTY_SURPRISE_EVERY = 5;

const HEADERS = [
  "id","name","phone","ig","date","time","notes","serviceLabel","total","status","submittedAt","photoUrls","dealsUsed",
  "bookingType","partnerName","partnerContact","giftKit","careKitCost","visitCount","loyaltyFlag"
];

function getSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Bookings");
  if(!sheet){
    sheet = ss.insertSheet("Bookings");
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getPhotoFolder(){
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if(folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function savePhotos(photosArray){
  if(!photosArray || !photosArray.length) return [];
  const folder = getPhotoFolder();
  const urls = [];
  photosArray.forEach((dataUrl, i) => {
    try{
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.substring(0, commaIdx);
      const base64 = dataUrl.substring(commaIdx + 1);
      const contentType = meta.match(/data:(.*?);base64/)[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(base64), contentType, "photo_" + Date.now() + "_" + i + ".jpg");
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());
    }catch(e){ /* skip a bad photo rather than failing the whole booking */ }
  });
  return urls;
}

// Turns "2026-09-25" into "09/25/2026". Plain text, on purpose — see formatSheet().
function formatDateStr(dateStr){
  if(!dateStr) return "";
  const parts = String(dateStr).split("-");
  if(parts.length !== 3) return dateStr;
  return parts[1] + "/" + parts[2] + "/" + parts[0];
}

// Turns "15:46" into "3:46 PM". Plain text, on purpose — see formatSheet().
function formatTimeStr(timeStr){
  if(!timeStr) return "";
  const parts = String(timeStr).split(":");
  if(parts.length < 2) return timeStr;
  let h = parseInt(parts[0], 10);
  const m = parts[1];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if(h === 0) h = 12;
  return h + ":" + m + " " + ampm;
}

// Human-readable "submitted at" stamp, written as plain text so Sheets never
// reinterprets it (that reinterpretation — auto date-detection plus a timezone
// shift — is exactly what produced the giant confusing number before).
function formatTimestamp(ms){
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "MM/dd/yyyy hh:mm a");
}

// Counts approved bookings for a phone number, for internal visit tracking.
// excludeRowIndex is a 0-based index into getDataRange().getValues() (header
// row included) to skip — used when recomputing a row's own count so it
// doesn't count itself. Pass -1 to not exclude anything.
function countApprovedForPhone(phone, excludeRowIndex){
  if(!phone) return 0;
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  let count = 0;
  for(let i=1; i<data.length; i++){
    if(i === excludeRowIndex) continue;
    if(String(data[i][2]) === String(phone) && data[i][9] === "approved") count++;
  }
  return count;
}

function handleCreate(body){
  const sheet = getSheet();
  const id = "b_" + new Date().getTime() + "_" + Math.floor(Math.random()*10000);
  const photoUrls = savePhotos(body.photos);
  const niceDate = formatDateStr(body.date);
  const niceTime = formatTimeStr(body.time);
  const niceSubmittedAt = formatTimestamp(new Date().getTime());

  // Internal-only tracking — not sent back to the client, just for your dashboard.
  // This is an estimate at submission time (their Nth visit IF this one gets approved);
  // handleUpdateStatus recomputes it for real when a booking is actually approved,
  // in case bookings get approved out of chronological order.
  const visitCount = countApprovedForPhone(body.phone, -1) + 1;
  const loyaltyFlag = (visitCount % LOYALTY_SURPRISE_EVERY === 0);

  sheet.appendRow([
    id, body.name || "", body.phone || "", body.ig || "", niceDate, niceTime,
    body.notes || "", body.serviceLabel || "", body.total || 0, "pending",
    niceSubmittedAt, photoUrls.join("|"), body.dealsLabel || "",
    body.bookingType || "solo", body.partnerName || "", body.partnerContact || "",
    body.giftKit || "", body.careKitCost || "", visitCount, loyaltyFlag
  ]);

  try{
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: "New Ehiffect booking request — " + (body.name || "unknown"),
      body:
        "New booking request!\n\n" +
        "Name: " + (body.name||"") + "\n" +
        "Phone: " + (body.phone||"") + "\n" +
        "IG: " + (body.ig||"") + "\n" +
        "Service: " + (body.serviceLabel||"") + "\n" +
        (body.dealsLabel ? "Deals: " + body.dealsLabel + "\n" : "") +
        (body.bookingType && body.bookingType !== "solo" ? "Booking type: " + body.bookingType + " — partner: " + (body.partnerName||"") + " " + (body.partnerContact||"") + "\n" : "") +
        (body.giftKit ? "Care kit: " + body.giftKit + "\n" : "") +
        (body.careKitCost ? "Bundle care kit: " + body.careKitCost + "\n" : "") +
        "Total: $" + (body.total||0) + "\n" +
        "Preferred date/time: " + niceDate + " " + niceTime + "\n" +
        "Notes: " + (body.notes||"") + "\n" +
        (photoUrls.length ? "Photos:\n" + photoUrls.join("\n") + "\n" : "") +
        (loyaltyFlag ? "\n🎉 If approved, this would be visit #" + visitCount + " for this client — surprise loyalty gift time!\n" : "") +
        "\nApprove or deny it from your dashboard."
    });
  }catch(err){ /* email failure shouldn't block the booking from saving */ }

  return { ok:true, key:id };
}

function handleUpdateStatus(body){
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  for(let i=1; i<data.length; i++){
    if(data[i][0] === body.key){
      sheet.getRange(i+1, 10).setValue(body.status); // column 10 = status
      if(body.status === "approved"){
        const phone = data[i][2];
        const visitCount = countApprovedForPhone(phone, i) + 1;
        const loyaltyFlag = (visitCount % LOYALTY_SURPRISE_EVERY === 0);
        sheet.getRange(i+1, 19).setValue(visitCount);   // column 19 = visitCount
        sheet.getRange(i+1, 20).setValue(loyaltyFlag);  // column 20 = loyaltyFlag
      }
      break;
    }
  }
  return { ok:true };
}

function doGet(e){
  const action = e.parameter.action;

  if(action === "list"){
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    const rows = data.slice(1); // skip header
    const bookings = rows.map(r => ({
      key: r[0], name: r[1], phone: r[2], ig: r[3], date: r[4], time: r[5],
      notes: r[6], serviceLabel: r[7], total: r[8], status: r[9],
      submittedAt: r[10], photos: r[11] ? r[11].split("|") : [], dealsUsed: r[12] || "",
      bookingType: r[13] || "solo", partnerName: r[14] || "", partnerContact: r[15] || "",
      giftKit: r[16] || "", careKitCost: r[17] || "", visitCount: r[18] || 0, loyaltyFlag: r[19] || false
    }));
    return ContentService.createTextOutput(JSON.stringify({ bookings }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Lightweight, privacy-conscious lookup for the public booking page: returns
  // only a count/boolean for ONE phone number, not the rest of the client list.
  if(action === "checkVisits"){
    const phone = e.parameter.phone || "";
    const count = countApprovedForPhone(phone, -1);
    return ContentService.createTextOutput(JSON.stringify({ approvedCount: count, isFirstTime: count === 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if(action === "create" || action === "updateStatus"){
    let body;
    try{ body = JSON.parse(e.parameter.payload); }
    catch(err){ return ContentService.createTextOutput(JSON.stringify({ error:"bad payload" })).setMimeType(ContentService.MimeType.JSON); }

    const result = action === "create" ? handleCreate(body) : handleUpdateStatus(body);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// kept as a fallback in case anything ever does reach doPost directly —
// not relied on by the website anymore, but harmless to leave in place.
function doPost(e){
  let body;
  if(e.parameter && e.parameter.payload){ body = JSON.parse(e.parameter.payload); }
  else if(e.postData && e.postData.contents){ body = JSON.parse(e.postData.contents); }
  else { return ContentService.createTextOutput(JSON.stringify({ error:"no data received" })).setMimeType(ContentService.MimeType.JSON); }

  if(body.action === "create") return ContentService.createTextOutput(JSON.stringify(handleCreate(body))).setMimeType(ContentService.MimeType.JSON);
  if(body.action === "updateStatus") return ContentService.createTextOutput(JSON.stringify(handleUpdateStatus(body))).setMimeType(ContentService.MimeType.JSON);
  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" })).setMimeType(ContentService.MimeType.JSON);
}

// Adds any header columns that are missing (e.g. new columns from an update)
// without touching ones that already exist — safe to run anytime.
function ensureHeaders(){
  const sheet = getSheet();
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const currentHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  HEADERS.forEach((h, i) => {
    if(currentHeaders[i] !== h){
      sheet.getRange(1, i + 1).setValue(h);
    }
  });
}

/**
 * ONE-TIME SETUP — makes the sheet actually pleasant to use.
 * Run this once: open this file in the Apps Script editor, pick
 * "formatSheet" from the function dropdown at the top (next to Debug),
 * click Run, and approve any permission prompt. Safe to run again anytime
 * (e.g. after adding new rows, or after this update) to reapply everything.
 */
function formatSheet(){
  ensureHeaders();
  const sheet = getSheet();
  const FUTURE_PROOF_ROWS = 1000; // formats this many rows ahead so new bookings inherit it automatically

  // header styling
  const header = sheet.getRange(1, 1, 1, HEADERS.length);
  header.setBackground("#B85C82").setFontColor("#FFFFFF").setFontWeight("bold").setFontSize(11);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  // column widths — id, name, phone, ig, date, time, notes, service, total, status, submittedAt,
  // photos, dealsUsed, bookingType, partnerName, partnerContact, giftKit, careKitCost, visitCount, loyaltyFlag
  const widths = [0, 130, 110, 110, 90, 90, 220, 260, 70, 100, 150, 260, 220, 100, 130, 150, 220, 90, 80, 90];
  widths.forEach((w, i) => { if(w) sheet.setColumnWidth(i+1, w); });
  sheet.hideColumns(1); // hide the internal id column, you don't need to see it

  // wrap long text columns — applied ahead of current data too
  sheet.getRange(2, 7, FUTURE_PROOF_ROWS, 1).setWrap(true);   // notes
  sheet.getRange(2, 8, FUTURE_PROOF_ROWS, 1).setWrap(true);   // serviceLabel
  sheet.getRange(2, 12, FUTURE_PROOF_ROWS, 1).setWrap(true);  // photoUrls
  sheet.getRange(2, 13, FUTURE_PROOF_ROWS, 1).setWrap(true);  // dealsUsed
  sheet.getRange(2, 16, FUTURE_PROOF_ROWS, 1).setWrap(true);  // giftKit

  // Lock date (E), time (F), and submittedAt (K) as PLAIN TEXT — applied to future rows too.
  // This is the actual fix for the "random number"/garbled date problem: Google Sheets
  // auto-detects text that looks like a date or time and silently converts it into its
  // own date/time serial value (with a timezone shift), which is what produced the
  // confusing numbers before. Locking these columns as text stops that from ever happening
  // again, since the script now always writes an already-formatted, human-readable string.
  sheet.getRange(2, 5, FUTURE_PROOF_ROWS, 1).setNumberFormat("@");
  sheet.getRange(2, 6, FUTURE_PROOF_ROWS, 1).setNumberFormat("@");
  sheet.getRange(2, 11, FUTURE_PROOF_ROWS, 1).setNumberFormat("@");

  // dropdown on the status column (column 10)
  const statusRange = sheet.getRange(2, 10, FUTURE_PROOF_ROWS, 1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["pending", "approved", "denied", "no-show"], true)
    .setAllowInvalid(false)
    .build();
  statusRange.setDataValidation(rule);

  // color-code status automatically
  sheet.clearConditionalFormatRules();
  const rules = [
    { text: "approved", bg: "#C9E3C6", fg: "#2F5C2B" },
    { text: "denied",   bg: "#E9C9C9", fg: "#7A2F2F" },
    { text: "no-show",  bg: "#D6C9F0", fg: "#4A3670" },
    { text: "pending",  bg: "#F5E3B3", fg: "#7A5C14" },
  ].map(r =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(r.text)
      .setBackground(r.bg).setFontColor(r.fg).setBold(true)
      .setRanges([statusRange])
      .build()
  );

  // highlight the loyaltyFlag column (T) when TRUE, as a visual heads-up
  const loyaltyRange = sheet.getRange(2, 20, FUTURE_PROOF_ROWS, 1);
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("TRUE")
      .setBackground("#F0D9A8").setFontColor("#7A5C14").setBold(true)
      .setRanges([loyaltyRange])
      .build()
  );
  sheet.setConditionalFormatRules(rules);

  SpreadsheetApp.flush();
}

function testEmail(){
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: "Test email from Ehiffect script",
    body: "If you're reading this, email sending works!"
  });
}
