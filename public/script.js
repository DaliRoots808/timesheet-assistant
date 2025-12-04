document.addEventListener('DOMContentLoaded', () => {
  const transcriptInput = document.getElementById('transcript');
  const recordBtn = document.getElementById('recordBtn');
  const buildTableBtn = document.getElementById('buildTableBtn');
  const outputTable = document.getElementById('outputTable');
  const recordingOverlay = document.getElementById('recordingOverlay');

  const notesInput = document.getElementById('notes');
  const recordNotesBtn = document.getElementById('recordNotesBtn');
  const buildReportBtn = document.getElementById('finalReportBtn');
  const finalReportOutput = document.getElementById('finalReportOutput');
  const copyReportBtn = document.getElementById('copyReportBtn');

  const copyCsvBtn = document.getElementById('copyCsvBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');

  let currentCsv = '';

  // ---- Helpers for time + hours (CrewTech-style) ----
  function parse12To24(timeStr) {
    // "08:00 AM" -> "08:00", "4:15 pm" -> "16:15"
    if (!timeStr) return '';
    let s = String(timeStr).trim().toLowerCase();
    if (!s) return '';
    // normalize "8 am" -> "8:00 am"
    const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return '';
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function time24To12(timeStr) {
    // "08:00" -> "08:00 AM", "16:15" -> "04:15 PM"
    if (!timeStr) return '';
    const [hStr, mStr] = String(timeStr).split(':');
    if (!hStr) return '';
    let hour = parseInt(hStr, 10);
    const minute = mStr != null ? parseInt(mStr, 10) : 0;
    const isPM = hour >= 12;
    let displayHour = hour % 12;
    if (displayHour === 0) displayHour = 12;
    const hh = String(displayHour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    const suffix = isPM ? 'PM' : 'AM';
    return `${hh}:${mm} ${suffix}`;
  }

  function calcHoursFrom24(startVal, endVal) {
    // startVal/endVal are "HH:MM" (24-hr). Return decimal string like "8.00" or "" if invalid.
    if (!startVal || !endVal) return '';
    const sParts = startVal.split(':');
    const eParts = endVal.split(':');
    if (sParts.length < 2 || eParts.length < 2) return '';
    const sh = parseInt(sParts[0], 10);
    const sm = parseInt(sParts[1], 10);
    const eh = parseInt(eParts[0], 10);
    const em = parseInt(eParts[1], 10);
    if (Number.isNaN(sh) || Number.isNaN(sm) || Number.isNaN(eh) || Number.isNaN(em)) return '';
    const startMinutes = sh * 60 + sm;
    let endMinutes = eh * 60 + em;
    // if end <= start, assume same-day but user error; just return empty
    if (endMinutes <= startMinutes) return '';
    let hours = (endMinutes - startMinutes) / 60;
    hours = Math.round(hours * 4) / 4; // nearest 0.25
    return hours.toFixed(2);
  }

  // --- Helpers to build final report text from table + notes ---
  function parseDateKeyForSort(dateStr) {
    if (!dateStr) return Number.POSITIVE_INFINITY;
    const parts = dateStr.split('/');
    if (parts.length !== 3) return Number.POSITIVE_INFINITY;
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (Number.isNaN(m) || Number.isNaN(d) || Number.isNaN(y)) {
      return Number.POSITIVE_INFINITY;
    }
    return y * 10000 + m * 100 + d; // yyyymmdd
  }

  function parseTimeToMinutes12(timeStr) {
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

  // Read rows from the editable table into JS objects
  function getTimesheetRowsFromDom() {
    const table = document.getElementById('timesheetTable');
    const rows = [];
    if (!table) return rows;

    const headerRow = table.querySelector('thead tr');
    const bodyRows = table.querySelectorAll('tbody tr');
    if (!headerRow || !bodyRows.length) return rows;

    const headers = Array.from(headerRow.querySelectorAll('th')).map((th) =>
      th.textContent.trim().toLowerCase()
    );

    const dateIdx = headers.indexOf('date');
    const siteIdx = headers.indexOf('job site');
    const workerIdx = headers.indexOf('worker name');
    const startIdx = headers.indexOf('start');
    const endIdx = headers.indexOf('end');
    const hoursIdx = headers.indexOf('hours');

    bodyRows.forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll('td'));

      function getCellText(idx) {
        const td = tds[idx];
        if (!td) return '';
        const input = td.querySelector('input');
        if (input) {
          const val = (input.value || '').trim();
          if (input.dataset.field === 'start' || input.dataset.field === 'end') {
            return time24To12(val);
          }
          return val;
        }
        if (idx === dateIdx) {
          const full = td.getAttribute('data-full-date');
          if (full) return full.trim();
        }
        return td.textContent.trim();
      }

      const date = dateIdx >= 0 ? getCellText(dateIdx) : '';
      const site = siteIdx >= 0 ? getCellText(siteIdx) : '';
      const worker = workerIdx >= 0 ? getCellText(workerIdx) : '';
      const start = startIdx >= 0 ? getCellText(startIdx) : '';
      const end = endIdx >= 0 ? getCellText(endIdx) : '';
      const hoursStr = hoursIdx >= 0 ? getCellText(hoursIdx) : '';
      const hours = parseFloat(hoursStr) || 0;

      if (!worker && !start && !end && !hoursStr) {
        return;
      }

      rows.push({ date, site, worker, start, end, hours });
    });

    return rows;
  }

  function groupRowsByDate(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const key = row.date || '(no date)';
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(row);
    });

    const entries = Array.from(map.entries());
    entries.sort((a, b) => parseDateKeyForSort(a[0]) - parseDateKeyForSort(b[0]));
    entries.forEach(([date, list]) => {
      list.sort((r1, r2) => {
        const t1 = parseTimeToMinutes12(r1.start);
        const t2 = parseTimeToMinutes12(r2.start);
        if (t1 !== t2) return t1 - t2;
        return r1.worker.toLowerCase().localeCompare(r2.worker.toLowerCase());
      });
    });
    return entries; // [ [date, [rows…]], … ]
  }

  function buildSummaryByWorker(rows) {
    const workerMap = new Map();
    rows.forEach((row) => {
      const worker = row.worker || '(no name)';
      const date = row.date || '(no date)';
      const hours = row.hours || 0;

      if (!workerMap.has(worker)) {
        workerMap.set(worker, { total: 0, perDate: new Map() });
      }
      const entry = workerMap.get(worker);
      entry.total += hours;
      entry.perDate.set(date, (entry.perDate.get(date) || 0) + hours);
    });

    const workers = Array.from(workerMap.entries());
    workers.sort((a, b) =>
      a[0].toLowerCase().localeCompare(b[0].toLowerCase())
    );
    return workers; // [ [workerName, { total, perDate: Map }], … ]
  }

  function pickPrimaryJobSite(rows) {
    const counts = new Map();
    rows.forEach((r) => {
      const site = (r.site || '').trim();
      if (!site) return;
      counts.set(site, (counts.get(site) || 0) + 1);
    });
    if (!counts.size) return 'Job Site';
    let best = null;
    let bestCount = -1;
    counts.forEach((count, site) => {
      if (count > bestCount) {
        bestCount = count;
        best = site;
      }
    });
    return best || 'Job Site';
  }

  function buildFinalReportTextFromRows(rows, notesText) {
    if (!rows.length) {
      return 'No rows found in the timesheet table.';
    }

    // sort rows by date, then time
    rows.sort((a, b) => {
      const dKeyA = parseDateKeyForSort(a.date);
      const dKeyB = parseDateKeyForSort(b.date);
      if (dKeyA !== dKeyB) return dKeyA - dKeyB;
      const tKeyA = parseTimeToMinutes12(a.start);
      const tKeyB = parseTimeToMinutes12(b.start);
      if (tKeyA !== tKeyB) return tKeyA - tKeyB;
      return a.worker.toLowerCase().localeCompare(b.worker.toLowerCase());
    });

    const allDates = rows
      .map((r) => r.date)
      .filter((d) => d && d !== '(no date)');
    allDates.sort((a, b) => parseDateKeyForSort(a) - parseDateKeyForSort(b));

    const firstDate = allDates[0] || '';
    const lastDate = allDates[allDates.length - 1] || firstDate;
    const dateRangeLine =
      firstDate && lastDate && firstDate !== lastDate
        ? `${firstDate} - ${lastDate}`
        : firstDate || '(no date)';

    const primarySite = pickPrimaryJobSite(rows);

    const lines = [];

    // Header
    lines.push(`Job: ${primarySite}`);
    lines.push(`Dates Worked: ${dateRangeLine}`);
    lines.push(`Location: ${primarySite}`);
    lines.push('');

    // Daily breakdown
    lines.push('-- DAILY BREAKDOWN --');
    lines.push('');

    const groupedByDate = groupRowsByDate(rows);
    groupedByDate.forEach(([date, list]) => {
      const label = date === '(no date)' ? 'No specific date' : date;
      lines.push(`${label}:`);
      list.forEach((r) => {
        const hrs = r.hours ? r.hours.toFixed(2) : '';
        lines.push(
          `- ${r.worker}: ${r.start} to ${r.end} (${hrs} hrs)`
        );
      });
      lines.push('');
    });

    // Summary by worker
    lines.push('-- SUMMARY BY WORKER --');
    lines.push('');

    const workers = buildSummaryByWorker(rows);
    workers.forEach(([workerName, info]) => {
      lines.push(`${workerName}:`);
      const dateEntries = Array.from(info.perDate.entries());
      dateEntries.sort(
        (a, b) => parseDateKeyForSort(a[0]) - parseDateKeyForSort(b[0])
      );
      dateEntries.forEach(([date, hrs]) => {
        const label = date === '(no date)' ? 'No date' : date;
        lines.push(`- ${label}: ${hrs.toFixed(2)} hrs`);
      });
      lines.push(`Total: ${info.total.toFixed(2)} hrs`);
      lines.push('');
    });

    // Notes
    const cleanNotes = (notesText || '').trim();
    if (cleanNotes) {
      lines.push('-- NOTES --');
      lines.push(cleanNotes);
    }

    return lines.join('\n');
  }
  // ---------------------------------------------------------------------------
  // Helper: render editable table from CSV (data rows only; summary is rebuilt)
  // ---------------------------------------------------------------------------
  function renderEditableTableFromCsv(csv) {
    if (!csv) {
      outputTable.innerHTML = '<p class="muted">No table data yet.</p>';
      return;
    }

    const lines = csv
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const headerIndex = lines.findIndex((l) =>
      l.toLowerCase().startsWith('date,')
    );
    if (headerIndex === -1) {
      outputTable.innerHTML =
        '<p class="muted">No valid header row found in CSV.</p>';
      return;
    }

    const headerCells = lines[headerIndex].split(',').map((h) => h.trim());

    const dataLines = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('Summary,')) break; // ignore summary part
      dataLines.push(line);
    }

    if (!dataLines.length) {
      outputTable.innerHTML =
        '<p class="muted">No worker rows found. Try dictating again.</p>';
      return;
    }

    // figure out column indexes
    const startIdx = headerCells.findIndex(
      (h) => h.toLowerCase() === 'start'
    );
    const endIdx = headerCells.findIndex(
      (h) => h.toLowerCase() === 'end'
    );
    const hoursIdx = headerCells.findIndex(
      (h) => h.toLowerCase() === 'hours'
    );
    const dateIdx = headerCells.findIndex((h) => h.toLowerCase() === 'date');

    // --- Helpers for sorting data lines by date/time/worker ---
    function parseCsvDateKey(dateStr) {
      if (!dateStr) return Number.POSITIVE_INFINITY;
      const parts = dateStr.split('/');
      if (parts.length !== 3) return Number.POSITIVE_INFINITY;
      const m = parseInt(parts[0], 10);
      const d = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      if (Number.isNaN(m) || Number.isNaN(d) || Number.isNaN(y)) {
        return Number.POSITIVE_INFINITY;
      }
      return y * 10000 + m * 100 + d; // yyyymmdd
    }

    function parseCsvTimeKey(timeStr) {
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

    const workerIdx = headerCells.findIndex(
      (h) => h.toLowerCase() === 'worker name'
    );
    const siteIdx = headerCells.findIndex(
      (h) => h.toLowerCase() === 'job site'
    );

    // sort the data lines IN PLACE before rendering
    dataLines.sort((a, b) => {
      const aCells = a.split(',');
      const bCells = b.split(',');

      const dateA = (aCells[dateIdx] || '').trim();
      const dateB = (bCells[dateIdx] || '').trim();
      const dKeyA = parseCsvDateKey(dateA);
      const dKeyB = parseCsvDateKey(dateB);
      if (dKeyA !== dKeyB) return dKeyA - dKeyB;

      const startA = (aCells[startIdx] || '').trim();
      const startB = (bCells[startIdx] || '').trim();
      const tKeyA = parseCsvTimeKey(startA);
      const tKeyB = parseCsvTimeKey(startB);
      if (tKeyA !== tKeyB) return tKeyA - tKeyB;

      const workerA = (aCells[workerIdx] || '').trim().toLowerCase();
      const workerB = (bCells[workerIdx] || '').trim().toLowerCase();
      if (workerA < workerB) return -1;
      if (workerA > workerB) return 1;

      const siteA = (aCells[siteIdx] || '').trim().toLowerCase();
      const siteB = (bCells[siteIdx] || '').trim().toLowerCase();
      if (siteA < siteB) return -1;
      if (siteA > siteB) return 1;

      return 0;
    });

    let html = `
<section class="section">
  <h3>Workers &amp; Hours</h3>
  <p class="muted">Edit any cell. This table is the source of truth.</p>
  <div class="field">
    <div class="scroll-x">
      <table class="table" id="timesheetTable">
        <thead>
          <tr>
            ${headerCells.map((h) => `<th>${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
`;

    dataLines.forEach((line) => {
      const rawCells = line.split(',');
      html += '<tr>';
      headerCells.forEach((_, idx) => {
        const raw = (rawCells[idx] || '').trim();
        const safe = raw.replace(/,/g, ' ');

        if (idx === startIdx) {
          const v24 = parse12To24(safe);
          html += `<td><input type="time" class="ts-input" data-field="start" value="${v24}"></td>`;
        } else if (idx === endIdx) {
          const v24 = parse12To24(safe);
          html += `<td><input type="time" class="ts-input" data-field="end" value="${v24}"></td>`;
        } else if (idx === hoursIdx) {
          html += `<td><input type="number" class="ts-input" data-field="hours" step="0.25" min="0" value="${safe || ''}"></td>`;
        } else if (idx === dateIdx) {
          // shorten date visually to MM/DD but keep full in data attribute
          const fullDate = safe;
          let shortDate = safe;
          const parts = safe.split('/');
          if (parts.length === 3) {
            shortDate =
              parts[0].padStart(2, '0') + '/' + parts[1].padStart(2, '0');
          }
          html += `<td contenteditable="true" data-field="date" data-full-date="${fullDate}">${shortDate}</td>`;
        } else {
          html += `<td contenteditable="true">${safe}</td>`;
        }
      });
      html += '</tr>';
    });

    html += `
        </tbody>
      </table>
    </div>
  </div>
</section>
`;

    outputTable.innerHTML = html;

    // Wire up auto-hours like CrewTech
    const table = document.getElementById('timesheetTable');
    if (!table) return;

    const bodyRows = table.querySelectorAll('tbody tr');
    bodyRows.forEach((tr) => {
      const startInput = tr.querySelector('input[data-field="start"]');
      const endInput = tr.querySelector('input[data-field="end"]');
      const hoursInput = tr.querySelector('input[data-field="hours"]');
      if (!startInput || !endInput || !hoursInput) return;

      const recalc = () => {
        const total = calcHoursFrom24(startInput.value, endInput.value);
        if (total !== '') {
          hoursInput.value = total;
        }
      };

      startInput.addEventListener('change', recalc);
      endInput.addEventListener('change', recalc);

      // initial calculation if hours is empty
      if (!hoursInput.value) {
        recalc();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: rebuild CSV from the editable table (and recompute summary)
  // ---------------------------------------------------------------------------
  function buildCsvFromTable() {
    const table = document.getElementById('timesheetTable');
    if (!table) {
      return currentCsv || '';
    }

    const headerCells = Array.from(table.querySelectorAll('thead th')).map(
      (th) => th.textContent.trim()
    );
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));

    if (!headerCells.length || !bodyRows.length) {
      return currentCsv || '';
    }

    const header = headerCells.join(',');

    const dataLines = [];
    const workerTotals = {};
    let overallHours = 0;

    const workerIndex =
      headerCells.findIndex(
        (h) =>
          h.toLowerCase() === 'worker name' ||
          h.toLowerCase() === 'worker'
      ) || 2; // fallback to 3rd col
    const hoursIndex = headerCells.findIndex(
      (h) => h.toLowerCase() === 'hours'
    );
    const startIndex = headerCells.findIndex(
      (h) => h.toLowerCase() === 'start'
    );
    const endIndex = headerCells.findIndex(
      (h) => h.toLowerCase() === 'end'
    );
    const dateIndex = headerCells.findIndex(
      (h) => h.toLowerCase() === 'date'
    );

    bodyRows.forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const rowValues = headerCells.map((_, idx) => {
        const td = tds[idx];
        if (!td) return '';

        const timeInput =
          td.querySelector('input[data-field="start"]') ||
          td.querySelector('input[data-field="end"]');
        const hoursInput = td.querySelector('input[data-field="hours"]');

        if (timeInput) {
          // from "HH:MM" -> "HH:MM AM/PM"
          return time24To12(timeInput.value || '');
        } else if (hoursInput) {
          const val = hoursInput.value || '';
          const num = parseFloat(val);
          return Number.isNaN(num) ? '' : num.toFixed(2);
        } else {
          // Date column: prefer full date from data attribute
          if (idx === dateIndex) {
            const full = td.getAttribute('data-full-date') || '';
            if (full) {
              return full.replace(/,/g, ' ');
            }
            // if user edited the visible value, try to rebuild full date using current year
            const visible = td.textContent.trim();
            const parts = visible.split('/');
            if (parts.length === 2) {
              const month = parts[0].padStart(2, '0');
              const day = parts[1].padStart(2, '0');
              const year = new Date().getFullYear().toString();
              return `${month}/${day}/${year}`;
            }
            // if empty, just return empty (no date)
            return '';
          }

          // All other plain-text cells
          return td.textContent.trim().replace(/,/g, ' ');
        }
      });

      dataLines.push(rowValues.join(','));

      // track hours for summaries
      if (hoursIndex >= 0 && hoursIndex < rowValues.length) {
        const rawHours = parseFloat(rowValues[hoursIndex] || '0');
        const hours = Number.isNaN(rawHours) ? 0 : rawHours;
        overallHours += hours;

        if (workerIndex >= 0 && workerIndex < rowValues.length) {
          const name = rowValues[workerIndex] || '';
          if (!workerTotals[name]) workerTotals[name] = 0;
          workerTotals[name] += hours;
        }
      }
    });

    const lines = [header, ...dataLines];

    if (hoursIndex >= 0) {
      lines.push('');
      const names = Object.keys(workerTotals).sort((a, b) =>
        a.localeCompare(b)
      );
      names.forEach((name) => {
        lines.push(
          `Summary,${name},${workerTotals[name].toFixed(2)}`
        );
      });
      lines.push(
        `Summary,Total Hours Overall,${overallHours.toFixed(2)}`
      );
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // STEP 1: Build Table (server /api/timesheet)
  // ---------------------------------------------------------------------------
  buildTableBtn.addEventListener('click', async () => {
    const transcript = (transcriptInput.value || '').trim();
    if (!transcript) {
      alert('Please speak or type some work details first.');
      return;
    }

    buildTableBtn.disabled = true;
    buildTableBtn.textContent = 'Building…';

    try {
      const res = await fetch('/api/timesheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Server error building timesheet');
      }

      const data = await res.json();
      currentCsv = data.csv || '';
      renderEditableTableFromCsv(currentCsv);
    } catch (err) {
      console.error(err);
      alert('Error generating table: ' + err.message);
    } finally {
      buildTableBtn.disabled = false;
      buildTableBtn.textContent = 'Build Table';
    }
  });

  // ---------------------------------------------------------------------------
  // STEP 3: Generate Final Report (local builder from table + notes)
  // ---------------------------------------------------------------------------
  if (buildReportBtn && finalReportOutput) {
    buildReportBtn.addEventListener('click', () => {
      const rows = getTimesheetRowsFromDom();
      if (!rows.length) {
        alert('No timesheet rows found. Generate the table first.');
        return;
      }
      const notesText = notesInput ? notesInput.value : '';
      const reportText = buildFinalReportTextFromRows(rows, notesText);
      finalReportOutput.value = reportText;
      finalReportOutput.scrollTop = 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Copy / Download CSV (uses currentCsv which tracks edited table)
  // ---------------------------------------------------------------------------
  copyCsvBtn.addEventListener('click', async () => {
    const csv = buildCsvFromTable();
    if (!csv) {
      alert('No CSV data yet. Build the table first.');
      return;
    }
    currentCsv = csv;

    try {
      await navigator.clipboard.writeText(csv);
      alert('CSV copied to clipboard.');
    } catch (err) {
      console.error('Clipboard error:', err);
      alert('Could not auto-copy CSV. Select and copy manually.');
    }
  });

  downloadCsvBtn.addEventListener('click', () => {
    const csv = buildCsvFromTable();
    if (!csv) {
      alert('No CSV data yet. Build the table first.');
      return;
    }
    currentCsv = csv;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'timesheet.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // --- COPY FULL REPORT HANDLER ---
  if (copyReportBtn && finalReportOutput) {
    copyReportBtn.addEventListener('click', async () => {
      const text = finalReportOutput.value.trim();

      if (!text) {
        alert('There is no full report text to copy yet.');
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        alert('Full report copied to clipboard.');
      } catch (err) {
        console.error('Clipboard error:', err);

        // Fallback for browsers that don't allow clipboard API
        finalReportOutput.focus();
        finalReportOutput.select();
        alert(
          'Could not auto-copy. The report text is selected — press Ctrl/Cmd + C.'
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Whisper-powered recording for transcript + notes (MediaRecorder)
  // ---------------------------------------------------------------------------
  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTarget = null;
  let recordingButton = null;

  async function startRecording(targetTextarea, button) {
    try {
      // If already recording, stop first
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        return;
      }

      recordingTarget = targetTextarea;
      recordingButton = button;
      audioChunks = [];

      if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType: 'audio/webm'
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // clear UI recording state
        document.body.classList.remove('recording-mode');
        if (recordingButton) {
          recordingButton.classList.remove('recording');
          recordingButton.disabled = false;
          recordingButton.textContent =
            recordingButton.dataset.defaultLabel || '🎤 Record';
        }

        // small haptic on stop (where supported)
        if (navigator.vibrate) {
          navigator.vibrate(30);
        }

        if (!audioChunks.length || !recordingTarget) {
          recordingTarget = null;
          recordingButton = null;
          audioChunks = [];
          return;
        }

        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        try {
          if (recordingButton) {
            recordingButton.textContent = 'Transcribing…';
            recordingButton.disabled = true;
          }

          const res = await fetch('/api/whisper', {
            method: 'POST',
            body: formData
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.error || 'Server error');
          }

          const data = await res.json();
          const text = (data.transcript || '').trim();

          if (text && recordingTarget) {
            const existing = recordingTarget.value
              ? recordingTarget.value + ' '
              : '';
            recordingTarget.value = (existing + text).trim();
          }
        } catch (err) {
          console.error('Whisper fetch error:', err);
          alert('Error transcribing audio: ' + err.message);
        } finally {
          if (recordingButton) {
            recordingButton.disabled = false;
            recordingButton.textContent =
              recordingButton.dataset.defaultLabel || '🎤 Record';
          }
          recordingTarget = null;
          recordingButton = null;
          audioChunks = [];
        }
      };

      mediaRecorder.start();

      // update UI to "recording" state
      if (button) {
        if (!button.dataset.defaultLabel) {
          button.dataset.defaultLabel = button.textContent || '🎤 Record';
        }
        button.classList.add('recording');
        button.textContent = '■ Stop Recording';
        button.disabled = false;
      }
      document.body.classList.add('recording-mode');

      // small haptic on start (where supported)
      if (navigator.vibrate) {
        navigator.vibrate(20);
      }
    } catch (err) {
      console.error('MediaRecorder error:', err);
      alert('Could not start microphone recording. Check mic permissions.');
      document.body.classList.remove('recording-mode');
      if (button) {
        button.classList.remove('recording');
        if (button.dataset.defaultLabel) {
          button.textContent = button.dataset.defaultLabel;
        }
        button.disabled = false;
      }
    }
  }

  recordBtn.addEventListener('click', () => {
    startRecording(transcriptInput, recordBtn);
  });

  recordNotesBtn.addEventListener('click', () => {
    startRecording(notesInput, recordNotesBtn);
  });
});
