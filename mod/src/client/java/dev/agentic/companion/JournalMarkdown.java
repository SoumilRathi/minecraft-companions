package dev.agentic.companion;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Small, tolerant Markdown reader for streaming chat; never interprets HTML. */
final class JournalMarkdown {
    record Block(String kind, String text, String detail, int level) { }
    record Span(String text, boolean bold, boolean italic, boolean code, boolean strike, String link) { }
    private static final Pattern HEADING = Pattern.compile("^(#{1,6})\\s+(.+?)\\s*#*\\s*$");
    private static final Pattern LIST = Pattern.compile("^(\\s*)([-+*]|\\d+[.)])\\s+(.+)$");
    private static final Pattern TABLE_RULE = Pattern.compile("^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$");

    static List<Block> blocks(String markdown) {
        var result = new ArrayList<Block>();
        String[] lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i], trimmed = line.strip();
            if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
                char mark = trimmed.charAt(0); int length = 0;
                while (length < trimmed.length() && trimmed.charAt(length) == mark) length++;
                String fence = String.valueOf(mark).repeat(length), language = trimmed.substring(length).strip();
                var content = new ArrayList<String>();
                while (++i < lines.length) {
                    String end = lines[i].strip();
                    if (end.startsWith(fence) && end.chars().allMatch(c -> c == mark)) break;
                    content.add(lines[i]);
                }
                result.add(new Block("code", String.join("\n", content), language, 0)); continue;
            }
            if (i + 1 < lines.length && line.contains("|") && TABLE_RULE.matcher(lines[i + 1]).matches()) {
                var rows = new ArrayList<String>(); rows.add(line); i++;
                while (i + 1 < lines.length && lines[i + 1].contains("|") && !lines[i + 1].isBlank()) rows.add(lines[++i]);
                result.add(new Block("table", String.join("\n", rows), "", 0)); continue;
            }
            if (trimmed.isEmpty()) { result.add(new Block("space", "", "", 0)); continue; }
            if (trimmed.matches("(-\\s*){3,}|(_\\s*){3,}|(\\*\\s*){3,}")) {
                result.add(new Block("rule", "", "", 0)); continue;
            }
            var heading = HEADING.matcher(trimmed);
            if (heading.matches()) { result.add(new Block("heading", heading.group(2), "", heading.group(1).length())); continue; }
            var list = LIST.matcher(line);
            if (list.matches()) {
                String prefix = list.group(2).matches("\\d+[.)]") ? list.group(2) : "•";
                String body = list.group(3);
                if (body.startsWith("[ ] ")) { prefix = "□"; body = body.substring(4); }
                else if (body.startsWith("[x] ") || body.startsWith("[X] ")) { prefix = "✓"; body = body.substring(4); }
                result.add(new Block("list", body, prefix, Math.min(4, list.group(1).length() / 2))); continue;
            }
            if (trimmed.startsWith(">")) { result.add(new Block("quote", trimmed.replaceFirst("^>\\s?", ""), "", 0)); continue; }
            result.add(new Block("paragraph", line, "", 0));
        }
        return result;
    }

    static List<Span> inline(String text) { return inline(text, false, false, false, 0); }
    private static List<Span> inline(String text, boolean bold, boolean italic, boolean strike, int depth) {
        var spans = new ArrayList<Span>(); var plain = new StringBuilder();
        if (depth > 12) return List.of(new Span(text, bold, italic, false, strike, null));
        for (int i = 0; i < text.length();) {
            if (text.charAt(i) == '\\' && i + 1 < text.length()) { plain.append(text.charAt(i + 1)); i += 2; continue; }
            String token = null;
            for (String candidate : new String[]{"`", "**", "__", "~~", "*", "_"}) {
                if (text.startsWith(candidate, i) && !(candidate.contains("_") && i > 0 && Character.isLetterOrDigit(text.charAt(i - 1)))) { token = candidate; break; }
            }
            int end = token == null ? -1 : text.indexOf(token, i + token.length());
            if (token != null && end > i + token.length()) {
                flush(spans, plain, bold, italic, strike);
                String inside = text.substring(i + token.length(), end);
                if (token.equals("`")) spans.add(new Span(inside, bold, italic, true, strike, null));
                else spans.addAll(inline(inside, bold || token.length() == 2 && !token.equals("~~"), italic || token.length() == 1,
                    strike || token.equals("~~"), depth + 1));
                i = end + token.length(); continue;
            }
            if (text.charAt(i) == '[') {
                int mid = text.indexOf("](", i + 1), close = mid < 0 ? -1 : text.indexOf(')', mid + 2);
                if (mid > i && close > mid) {
                    flush(spans, plain, bold, italic, strike);
                    spans.add(new Span(text.substring(i + 1, mid), bold, italic, false, strike, text.substring(mid + 2, close)));
                    i = close + 1; continue;
                }
            }
            plain.append(text.charAt(i++));
        }
        flush(spans, plain, bold, italic, strike); return spans;
    }
    private static void flush(List<Span> spans, StringBuilder text, boolean bold, boolean italic, boolean strike) {
        if (!text.isEmpty()) { spans.add(new Span(text.toString(), bold, italic, false, strike, null)); text.setLength(0); }
    }
    static String[] cells(String row) {
        String clean = row.strip();
        if (clean.startsWith("|")) clean = clean.substring(1);
        if (clean.endsWith("|")) clean = clean.substring(0, clean.length() - 1);
        return clean.split("(?<!\\\\)\\|", -1);
    }
}
