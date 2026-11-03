import type { TextFrame } from "./display";

/** Code page 437, the character set of the PC text console, as Unicode (indexed by byte). */
export const CP437 = (() => {
  const low = "\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼";
  const high =
    "⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
  let ascii = "";
  for (let c = 0x20; c < 0x7f; c++) ascii += String.fromCharCode(c);
  return [...(low + ascii + high)];
})();

/** The text on a VGA text screen, one string per row, trailing blanks removed. */
export function frameText(frame: TextFrame): string[] {
  const rows: string[] = [];
  for (let r = 0; r < frame.rows; r++) {
    let line = "";
    for (let c = 0; c < frame.cols; c++) line += CP437[frame.chars[r * frame.cols + c]] ?? " ";
    rows.push(line.replace(/\0/g, " ").trimEnd());
  }
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows;
}
