import { MODULE_ID } from "./constants.mjs";

const sheets = new WeakMap();

function calendarRows(calendar, date) {
  const month = calendar.months?.values[date.month];
  if (!month) return null;
  const length = (date.leapYear ? month.leapDays : null) ?? month.days;
  const columns = calendar.days.values.length || 10;
  const rows = [];
  let row = [];
  for (let day = 1; day <= length; day++) {
    const festival = calendar.findFestivalDay?.({ ...date, dayOfMonth: day - 1 });
    if (festival) {
      if (row.length) rows.push(row);
      rows.push([{ day, label: game.i18n.localize(festival.name), festival: true }]);
      row = [];
    } else {
      row.push({ day, label: String(day) });
      if (row.length === columns) {
        rows.push(row);
        row = [];
      }
    }
  }
  if (row.length) rows.push(row);
  return { title: game.i18n.localize(month.name), columns, rows };
}

function drawCalendar(paper, source, month, today) {
  const ctx = paper.getContext("2d");
  ctx.clearRect(0, 0, paper.width, paper.height);
  ctx.drawImage(source, 0, 0, paper.width, paper.height);
  ctx.save();
  ctx.scale(paper.width / 1000, paper.height / 1000);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#39291c";
  ctx.font = '72px "Quest Fell", Georgia, serif';
  ctx.fillText(month.title, 500, 175, 780);
  const width = 820 / month.columns;
  const height = Math.min(140, 615 / month.rows.length);
  ctx.font = `${Math.min(54, width * 0.66)}px "Quest Fell", Georgia, serif`;
  for (const [index, row] of month.rows.entries()) {
    const y = 315 + height * (index + 0.5);
    for (const [column, cell] of row.entries()) {
      const x = cell.festival ? 500 : 90 + width * (column + 0.5);
      ctx.fillText(cell.label, x, y, cell.festival ? 760 : width - 6);
      if (cell.day > today) continue;
      const reach = Math.min(25, width * 0.35);
      ctx.beginPath();
      ctx.lineWidth = cell.day === today ? 6 : 3;
      ctx.strokeStyle = cell.day === today ? "#a02424" : "#694831";
      if (cell.day === today) {
        ctx.moveTo(x - reach, y - 26);
        ctx.lineTo(x + reach, y + 23);
        ctx.moveTo(x + reach, y - 24);
        ctx.lineTo(x - reach, y + 26);
      } else {
        const strike = Math.min(380, ctx.measureText(cell.label).width / 2 + 3);
        ctx.moveTo(x - strike, y + 3);
        ctx.lineTo(x + strike, y - 2);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function removeSheet(tile) {
  const previous = sheets.get(tile);
  if (!previous) return;
  if (tile.mesh?.texture === previous.texture) tile.mesh.texture = tile.texture;
  previous.texture.destroy(true);
  sheets.delete(tile);
}

function refreshSheet(tile) {
  if (!tile) return;
  if (!tile.document.getFlag(MODULE_ID, "calendarSheet")) return removeSheet(tile);
  const source = tile.texture?.baseTexture.resource?.source;
  if (!tile.mesh || !source || source instanceof HTMLVideoElement) return removeSheet(tile);
  const calendar = game.time.calendar;
  const date = game.time.components;
  const key = [date.year, date.day, game.i18n.lang].join("/");
  let sheet = sheets.get(tile);
  if (sheet?.source === source && sheet.calendar === calendar && sheet.day === key) {
    tile.mesh.texture = sheet.texture;
    return;
  }
  const month = calendarRows(calendar, date);
  if (!month) return removeSheet(tile);
  if (!sheet || sheet.source !== source) {
    removeSheet(tile);
    const paper = document.createElement("canvas");
    paper.width = tile.texture.width;
    paper.height = tile.texture.height;
    sheet = { paper, source, texture: PIXI.Texture.from(paper) };
    sheets.set(tile, sheet);
  }
  drawCalendar(sheet.paper, source, month, date.dayOfMonth + 1);
  sheet.day = key;
  sheet.calendar = calendar;
  sheet.texture.baseTexture.update();
  tile.mesh.texture = sheet.texture;
}

export function setupCalendarTiles() {
  // Decorate the tile's local texture so Foundry keeps its rotation, opacity, level and draw order.
  Hooks.on("drawTile", refreshSheet);
  Hooks.on("destroyTile", removeSheet);
  Hooks.on("updateTile", (doc, changes) => {
    if (changes.flags) refreshSheet(doc.object);
  });
  Hooks.on("updateWorldTime", () => {
    for (const tile of canvas.tiles?.placeables ?? []) {
      if (tile.document.getFlag(MODULE_ID, "calendarSheet")) refreshSheet(tile);
    }
  });
}
