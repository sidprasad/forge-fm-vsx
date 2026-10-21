export type ForgeDialect = 'froglet' | 'forge' | 'temporal' | 'unknown';

/** Mask non-code without moving UTF-16 offsets, including unfinished comments/strings. */
export function sourceContext(text: string): {
    code: string;
    dialect: ForgeDialect;
    isCode(offset: number): boolean;
} {
    const chars = text.split('');
    const regions: { start: number; end: number; closed: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
        const start = i;
        let closed = false;
        if (text.startsWith('//', i) || text.startsWith('--', i)) {
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') { i++; }
        } else if (text.startsWith('/*', i)) {
            i += 2;
            while (i < text.length && !text.startsWith('*/', i)) { i++; }
            if (i < text.length) { i += 2; closed = true; }
        } else if (text[i] === '"') {
            i++;
            while (i < text.length) {
                if (text[i] === '\\') { i = Math.min(text.length, i + 2); }
                else if (text[i++] === '"') { closed = true; break; }
            }
        } else {
            i++;
            continue;
        }
        regions.push({ start, end: i, closed });
        for (let j = start; j < i; j++) {
            if (chars[j] !== '\n' && chars[j] !== '\r') { chars[j] = ' '; }
        }
    }
    let code = chars.join('');
    const language = /^\s*#lang\s+([^\s]+)/.exec(code)?.[1];
    const dialect: ForgeDialect = language === 'forge/froglet' ? 'froglet' :
        language === 'forge' ? 'forge' : language === 'forge/temporal' ? 'temporal' : 'unknown';
    code = code.replace(/#lang[^\r\n]*/g, (line, start: number) => {
        regions.push({ start, end: start + line.length, closed: false });
        return ' '.repeat(line.length);
    });
    return {
        code, dialect,
        isCode: offset => !regions.some(r => offset > r.start && (offset < r.end || (!r.closed && offset === r.end)))
    };
}

export function wordAt(code: string, offset: number): { name: string; start: number; end: number } | undefined {
    const pattern = /[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
        if (offset >= match.index && offset <= match.index + match[0].length) {
            return { name: match[0], start: match.index, end: match.index + match[0].length };
        }
    }
    return undefined;
}
