require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Serve front-end from /public
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Multer storage: always save with an audio extension (webm by default)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const original = file.originalname || '';
    let ext = path.extname(original);
    if (!ext) {
      ext = '.webm';
    }
    cb(null, `recording-${Date.now()}${ext}`);
  }
});

const upload = multer({ storage });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// — Whisper transcription endpoint —
app.post('/api/whisper', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const filePath = req.file.path;
    console.log(
      'Whisper: received file',
      filePath,
      'mimetype=',
      req.file.mimetype
    );

    const transcriptRes = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      // Use a reliable default model; you can override via OPENAI_TRANSCRIBE_MODEL
      model: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1'
    });

    console.log('Whisper response:', transcriptRes);

    const text = (transcriptRes.text || '').trim();

    // Clean up temp file
    fs.unlink(filePath, () => {});

    if (!text) {
      return res.status(500).json({ error: 'Empty transcript from Whisper' });
    }

    res.json({ transcript: text });
  } catch (err) {
    console.error('Whisper error:', err);
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }

    res.status(500).json({
      error: err.message || 'Whisper transcription failed'
    });
  }
});

/**
 * /api/timesheet
 * Takes a freeform transcript and returns:
 * - csv: cleaned, sorted CSV
 * - htmlTable: HTML for main + summary tables
 */
app.post('/api/timesheet', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'Transcript required' });

  // Build a "today" date string like 11/05/2025
  const now = new Date();
  const todayNumeric = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }); // MM/DD/YYYY

  const prompt = `
You are an expert convention labor scheduler and timesheet formatter.

Your job is to:
  1. Read a messy, natural-language description of work done at convention venues.
  2. Infer structured job info (date, location, booth, etc.).
  3. Infer worker rows (who worked where and when).
  4. Output ONLY a clean CSV with worker rows and summary rows.

INPUT:
  • The user will speak or paste a log of work done for one or more days.
  • The text may mention:
    • Client names
    • Show names
    • City / hotel / hall
    • Booth numbers (e.g. “Booth W-3142”, “Booth 2239”, “Booth 55035”)
    • Multiple workers and multiple time ranges
    • The text may be incomplete or casual. You must make reasonable best guesses, but never hallucinate dates.

TODAY’S DATE:
${todayNumeric}

YOUR RULES:
  1. DATE HANDLING (VERY IMPORTANT)
    • Always output the Date column in this exact format: MM/DD/YYYY (with 4-digit year), or leave it completely blank if you truly cannot infer a date.
    • First, scan the transcript for any explicit calendar dates, such as:
      • Month name + day (e.g., “January 14th”, “Dec 2”)
      • Numeric dates (e.g., “01/14”, “1-14”, “1.14”)
    • If at least one explicit calendar date is found:
      • Use only those explicit dates for worker rows.
      • If there is exactly one explicit date, assume all workers in the transcript are on that same date unless a second, clearly different date is also stated.
      • Do NOT invent or use today’s date in this case.
    • Only use relative words like “today”, “tomorrow”, “yesterday”, “tonight” to resolve dates when those words are literally present in the text.
      • Example: “today” -> resolve relative to today’s date: ${todayNumeric}.
    • If the month/day is given but no year, assume the same year as today’s date.
      • If the text contains no explicit calendar date and no relative date words at all:
        • Leave the Date column blank for all worker rows (just an empty field before the first comma).
      • If multiple distinct dates are clearly referenced, emit separate rows for each date/worker combination.
  2. JOB SITE / LOCATION / BOOTH (INCLUDING CONTINUITY)
    • Interpret “job site” broadly: hotel, casino, convention center, expo hall, etc.
    • Use the shortest clear description of the job site, combining:
      • Location/hall name (e.g. “Caesars Palace”, “The Venetian”, “LVCC Central Hall”)
      • Booth number (if present), in the form: “Booth XYZ”
    • Example:
      • Text: “Caesars Palace, LVCC Central Hall, Booth W-3142”
      • Job Site column: “Caesars Palace Booth W-3142”
    • Booth continuity rule:
      • If the text first mentions a specific booth (e.g. “Booth 2239”) for a venue,
and later segments clearly talk about the same venue on later days
without naming a new booth, assume the same booth number continues.
      • Only change the booth if a new, different booth number is explicitly mentioned.
    • If no booth is mentioned anywhere, just use the location/hall as the Job Site.
    • If the text clearly talks about multiple distinct locations, assign each worker row to the correct location.
  3. WORKERS & TIME RANGES
    • Extract each distinct worker and their time range.
    • Worker Name:
      • Use the simplest clear version of the worker’s name (e.g., “John”, “Serena M.”).
      • Do not include job site or other notes in the Worker Name field.
    • Start / End:
      • Use 12-hour time with AM/PM (e.g., “08:00 AM”, “04:30 PM”).
      • Normalize fuzzy input like “8 to 4:30”, “7:45–3”, “10-6” into Start and End.
      • Prefer show/working hours (not setup-only or strike-only hours) if multiple ranges appear that obviously refer to different phases.
    • If the same worker is mentioned across multiple days, emit one row per day.
  4. HOURS CALCULATION
    • For each worker row, calculate total hours worked:
      • End minus Start, in decimal hours.
      • Round to the nearest 0.25 hour.
      • Examples:
        • 8:00–4:00 = 8.00
        • 7:45–3:10 ≈ 7.50
        • 10:00–6:15 ≈ 8.25
  5. OUTPUT FORMAT (CSV)
    • Output ONLY CSV lines, no explanations, no JSON, no markdown fences.
    • Header row must be exactly:
Date,Job Site,Worker Name,Start,End,Hours
    • Then one row per worker per date:
      • Date: MM/DD/YYYY (or blank if truly unknown)
      • Job Site: location and booth as described above
      • Worker Name
      • Start: hh:mm AM/PM
      • End: hh:mm AM/PM
      • Hours: decimal number with 2 decimal places
  6. SUMMARY ROWS
    • After all worker rows, add one empty line.
    • Then add summary rows in this exact format:
Summary,Worker Name,Total Hours
    • One summary row per worker, sorted alphabetically by worker name.
    • Then one final summary row:
Summary,Total Hours Overall,[total_hours_all_workers]
    • Use the same decimal-hours rounding and 2 decimal places.
  7. IMPORTANT STRICTNESS
    • NEVER output markdown fences like orcsv.
    • NEVER output JSON.
    • NEVER add commentary, labels, or extra text.
    • ONLY output valid CSV lines as described.

Transform this transcript into that CSV format:
“””${transcript}”””
`;

  try {
    const aiRes = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a strict timesheet CSV formatter.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 800
    });

    const raw = (aiRes.choices[0].message.content || '').trim();

    if (!raw) {
      console.error('Empty response from OpenAI');
      return res.status(500).json({ error: 'Empty response from OpenAI' });
    }

    // Split into lines and strip blanks
    let rawLines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Remove markdown fences like ``` or ```csv
    let cleanLines = rawLines.filter(
      (l) => !l.startsWith('```') && !l.toLowerCase().startsWith('csv')
    );

    // Find the first real header line (starts with "Date,")
    const headerIndex = cleanLines.findIndex((l) =>
      l.toLowerCase().startsWith('date,')
    );

    if (headerIndex === -1) {
      console.error('No header line starting with "Date," found.', cleanLines);
      return res.status(500).json({ error: 'No valid CSV header returned' });
    }

    const header = cleanLines[headerIndex];
    const dataRows = [];
    const summaryRows = [];

    // Process lines after the header
    for (let i = headerIndex + 1; i < cleanLines.length; i++) {
      const line = cleanLines[i];
      if (!line) continue;

      // Ignore any repeated header lines
      if (line.toLowerCase().startsWith('date,')) continue;

      if (line.startsWith('Summary,')) {
        summaryRows.push(line);
      } else {
        dataRows.push(line);
      }
    }

    function parseCsvDateToKey(dateStr) {
      if (!dateStr) return Number.POSITIVE_INFINITY;
      const parts = dateStr.split('/');
      if (parts.length !== 3) return Number.POSITIVE_INFINITY;
      const m = parseInt(parts[0], 10);
      const d = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      if (Number.isNaN(m) || Number.isNaN(d) || Number.isNaN(y)) {
        return Number.POSITIVE_INFINITY;
      }
      // yyyymmdd as a number
      return y * 10000 + m * 100 + d;
    }
    function parseCsvTimeToMinutes(timeStr) {
      // expects “HH:MM AM” or “HH:MM PM”
      if (!timeStr) return Number.POSITIVE_INFINITY;
      const s = String(timeStr).trim().toLowerCase();
      const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
      if (!m) return Number.POSITIVE_INFINITY;
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const ampm = m[3];
      if (Number.isNaN(hour) || Number.isNaN(minute)) {
        return Number.POSITIVE_INFINITY;
      }
      if (ampm === 'pm' && hour !== 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return hour * 60 + minute;
    }

    // --- Sort A-section (data rows) by Date, then Start time, then Worker Name ---
    dataRows.sort((a, b) => {
      const aCells = a.split(',');
      const bCells = b.split(',');
      const dateA = (aCells[0] || '').trim();
      const dateB = (bCells[0] || '').trim();
      const siteA = (aCells[1] || '').trim().toLowerCase();
      const siteB = (bCells[1] || '').trim().toLowerCase();
      const workerA = (aCells[2] || '').trim().toLowerCase();
      const workerB = (bCells[2] || '').trim().toLowerCase();
      const startA = (aCells[3] || '').trim();
      const startB = (bCells[3] || '').trim();
      const dKeyA = parseCsvDateToKey(dateA);
      const dKeyB = parseCsvDateToKey(dateB);
      if (dKeyA !== dKeyB) {
        return dKeyA - dKeyB;
      }
      const tKeyA = parseCsvTimeToMinutes(startA);
      const tKeyB = parseCsvTimeToMinutes(startB);
      if (tKeyA !== tKeyB) {
        return tKeyA - tKeyB;
      }
      // tie-breaker: job site then worker name
      if (siteA < siteB) return -1;
      if (siteA > siteB) return 1;
      if (workerA < workerB) return -1;
      if (workerA > workerB) return 1;
      return 0;
    });

    // --- Build Summary by Worker (with dates) from dataRows ---

    // Map: worker -> Map(dateStringOrEmpty -> totalHours)
    const workerDateMap = new Map();
    let overallHours = 0;

    dataRows.forEach((row) => {
      const cells = row.split(',');
      const date = (cells[0] || '').trim(); // full MM/DD/YYYY
      const worker = (cells[2] || '').trim();
      const hoursStr = (cells[5] || '').trim();
      const hours = parseFloat(hoursStr) || 0;

      if (!worker) return;

      overallHours += hours;

      const dateKey = date || '(no date)';
      if (!workerDateMap.has(worker)) {
        workerDateMap.set(worker, new Map());
      }
      const dateMap = workerDateMap.get(worker);
      dateMap.set(dateKey, (dateMap.get(dateKey) || 0) + hours);
    });

    // helper to sort "MM/DD/YYYY" and put "(no date)" last
    function summaryDateKey(d) {
      if (d === '(no date)') return Number.POSITIVE_INFINITY;
      const parts = d.split('/');
      if (parts.length !== 3) return Number.POSITIVE_INFINITY;
      const m = parseInt(parts[0], 10);
      const day = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      if (Number.isNaN(m) || Number.isNaN(day) || Number.isNaN(y)) {
        return Number.POSITIVE_INFINITY;
      }
      return y * 10000 + m * 100 + day;
    }

    // optional header-style row (still a normal CSV row)
    summaryRows.push('Summary,Worker Name - Date,Hours');

    const workersSorted = Array.from(workerDateMap.keys()).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    workersSorted.forEach((worker) => {
      const dateMap = workerDateMap.get(worker);
      const entries = Array.from(dateMap.entries());
      entries.sort((a, b) => summaryDateKey(a[0]) - summaryDateKey(b[0]));

      entries.forEach(([dateLabel, hrs]) => {
        const label =
          dateLabel === '(no date)'
            ? `${worker} - (no date)`
            : `${worker} - ${dateLabel}`;
        summaryRows.push(`Summary,${label},${hrs.toFixed(2)}`);
      });
    });

    // final overall row
    summaryRows.push(`Summary,Total Hours Overall,${overallHours.toFixed(2)}`);

    const sortedSummaryRows = summaryRows;

    // --- Rebuild CSV with sorted sections ---
    const csvParts = [header, ...dataRows];
    if (sortedSummaryRows.length > 0) {
      csvParts.push(''); // blank line between A and B in CSV
      csvParts.push(...sortedSummaryRows);
    }
    const newCsv = csvParts.join('\n');

    // --- Build HTML tables with CrewTech-style layout ---

    // Main worker table inside a "section" card
    let mainHtml = `

<section class="section">
  <h3>Workers & Hours</h3>
  <p class="muted">Review who worked and how long. Parsed automatically from your voice notes.</p>

  <div class="field">
    <label>Timesheet rows</label>
    <div class="scroll-x">
      <table class="table">
        <thead>
          <tr>
            ${
              header
                .split(',')
                .map((h) => `<th>${h.trim()}</th>`)
                .join('')
            }
          </tr>
        </thead>
        <tbody>
`;

    dataRows.forEach((row) => {
      const cells = row.split(',');
      mainHtml += `
          <tr>
            ${cells.map((cell) => `<td>${cell.trim()}</td>`).join('')}
          </tr>
`;
    });

    mainHtml += `
        </tbody>
      </table>
    </div>
  </div>
`;

    // Summary table (if any) styled like its own field
    if (sortedSummaryRows.length > 0) {
      mainHtml += `
  <div class="field">
    <label>Summary</label>
    <div class="scroll-x">
      <table class="table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Worker / Label</th>
            <th>Hours</th>
          </tr>
        </thead>
        <tbody>
`;
      sortedSummaryRows.forEach((row) => {
        const parts = row.split(',');
        const type = (parts[0] || '').trim();
        const label = (parts[1] || '').trim();
        const hours = (parts[2] || '').trim();
        mainHtml += `
          <tr>
            <td>${type}</td>
            <td>${label}</td>
            <td>${hours}</td>
          </tr>
`;
      });
      mainHtml += `
        </tbody>
      </table>
    </div>
  </div>
`;
    }

    mainHtml += `
</section>
`;
    const htmlTable = mainHtml;

    res.json({ csv: newCsv, htmlTable });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI call failed' });
  }
});

/**
 * /api/report
 * Takes CSV + rough notes and returns a CrewTech-style final report block.
 */
app.post('/api/report', async (req, res) => {
  const { csv, notes } = req.body || {};

  if (!csv && !notes) {
    return res.status(400).json({ error: 'CSV or notes required' });
  }

  const safeCsv = csv || '';
  const safeNotes =
    notes && notes.trim().length > 0
      ? notes
      : 'No additional notes were provided.';

  const prompt = `
You are helping a supervisor write a short, clear, professional summary of a work day
to send to a client or bookkeeper.

You will receive:
1) CSV lines describing worker hours.
2) Optional rough freeform notes from the supervisor.

The CSV will look like:

Date,Job Site,Worker Name,Start,End,Hours
11/26/2025,LVCC - Central Hall,John Doe,07:30 AM,04:45 PM,9.25
...

YOUR JOB:

- Read the CSV and understand:
  - The job(s) / job sites involved
  - The date(s)
  - The general schedule window (earliest start to latest end)
  - Each worker's hours
  - Total hours overall (there may already be a "Summary,Total Hours Overall" row)

- Then write ONE single block of plain text using THIS EXACT STRUCTURE
  (no bullets, no markdown, no extra labels):

  Job: [short description of the job or job sites involved]
  Date: [the main job date, or a compact range if multiple dates]
  Schedule: [overall schedule window, e.g. 7:30 AM – 4:45 PM]
  Location: [concise description of where the work took place]
  Workers:
  - [Worker 1 name] – [Job Site] – [Start]–[End] ([Hours] hrs)
  - [Worker 2 name] – [Job Site] – [Start]–[End] ([Hours] hrs)
  Total hours overall: [total hours across all workers, as a number with up to 2 decimals]
  Notes: [clean, professional rewrite of the supervisor's notes]

IMPORTANT RULES:

- Follow that exact label order and spelling: Job, Date, Schedule, Location, Workers, Total hours overall, Notes.
- Keep everything in plain text, no markdown, no extra headings, no code fences.
- Do NOT invent workers or hours that are not in the CSV.
- If there are multiple job sites, keep Job and Location short but clear (e.g. "Multiple booths across LVCC halls").
- If there is no meaningful notes content, use: "Notes: No additional notes were provided."

Here is the timesheet CSV:

"""${safeCsv}"""

Here are the rough notes from the supervisor:

"""${safeNotes}"""
`;

  try {
    const aiRes = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You write short, clear, professional work summaries in plain text.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 600
    });

    const text = (aiRes.choices[0].message.content || '').trim();

    if (!text) {
      return res.status(500).json({ error: 'Empty report from AI' });
    }

    res.json({ report: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI call failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
