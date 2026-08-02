import type { TerminalPalette } from "../../shared/theme/terminal-palette";
import type { TerminalBanner } from "./terminalBanner";
import { bannerColor, bannerStops } from "./terminalBannerColor";
import { TERMINAL_CELL_METRICS } from "./terminalRenderer";

export function paintTerminalBanner(
  canvas: HTMLCanvasElement,
  banner: TerminalBanner,
  palette: TerminalPalette,
  dpr: number,
): boolean {
  const bounds = canvas.getBoundingClientRect();
  const pixelWidth = Math.max(1, Math.round(bounds.width * dpr));
  const pixelHeight = Math.max(1, Math.round(bounds.height * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const context = canvas.getContext("2d");
  if (!context) return false;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  // The overlay sits above the grid canvas, so it needs its own opaque
  // ground: without one the shell output painted underneath shows through
  // the gaps between banner glyphs.
  context.fillStyle = palette.background;
  context.fillRect(0, 0, bounds.width, bounds.height);
  context.font = TERMINAL_CELL_METRICS.font;
  context.textBaseline = "alphabetic";

  const { stops } = bannerStops(palette);
  for (const [row, cells] of banner.cells.entries()) {
    for (const [column, cell] of cells.entries()) {
      if (cell.char === " " || !cell.layer) continue;
      context.fillStyle = bannerColor(palette, stops, cell.layer, cell.t);
      context.fillText(
        cell.char,
        column * TERMINAL_CELL_METRICS.width,
        row * TERMINAL_CELL_METRICS.height + TERMINAL_CELL_METRICS.baseline,
      );
    }
  }
  return true;
}
