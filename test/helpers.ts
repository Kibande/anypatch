/** Join lines with \n and end with a newline. */
export const L = (...lines: string[]) => lines.join('\n') + '\n';
/** Join lines with \n, no trailing newline. */
export const J = (...lines: string[]) => lines.join('\n');
