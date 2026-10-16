package dev.agentic.companion;

final class MacTextNavigation {
    private static int kind(int c) {
        if (Character.isWhitespace(c)) return 0;
        if (Character.isLetterOrDigit(c) || c == '_' || Character.getType(c) == Character.NON_SPACING_MARK) return 1;
        return 2;
    }
    static int previousWord(String text, int cursor) {
        int i = Math.clamp(cursor, 0, text.length());
        while (i > 0 && kind(text.codePointBefore(i)) == 0) i -= Character.charCount(text.codePointBefore(i));
        if (i == 0) return 0;
        int category = kind(text.codePointBefore(i));
        while (i > 0 && kind(text.codePointBefore(i)) == category) i -= Character.charCount(text.codePointBefore(i));
        return i;
    }
    static int nextWord(String text, int cursor) {
        int i = Math.clamp(cursor, 0, text.length());
        while (i < text.length() && kind(text.codePointAt(i)) == 0) i += Character.charCount(text.codePointAt(i));
        if (i == text.length()) return i;
        int category = kind(text.codePointAt(i));
        while (i < text.length() && kind(text.codePointAt(i)) == category) i += Character.charCount(text.codePointAt(i));
        return i;
    }
}
