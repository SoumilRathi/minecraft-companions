package dev.agentic.companion;

public final class JournalMarkdownTest {
    public static void main(String[] args) {
        var blocks = JournalMarkdown.blocks("# Heading\n- First **item**\n  - Nested\n> Quote\n```java\n# literal\n- still code\n```");
        check(blocks.get(0).kind().equals("heading"), "heading");
        check(blocks.get(2).level() == 1, "nested list indent");
        check(blocks.get(4).kind().equals("code") && blocks.get(4).text().equals("# literal\n- still code"), "code contents preserved");
        var streaming = JournalMarkdown.blocks("```\nincomplete **code");
        check(streaming.getFirst().text().equals("incomplete **code"), "unfinished streamed code fence");
        var table = JournalMarkdown.blocks("| Name | State |\n| --- | :---: |\n| Codex | Ready |");
        check(table.getFirst().kind().equals("table"), "table parsing");
        check(JournalMarkdown.cells("| a | b |").length == 2, "table cells");
        check(JournalMarkdown.cells("| a\\|b | c |").length == 2, "escaped pipe");
        var spans = JournalMarkdown.inline("**Bold** and *italic* and `a_b` and [Docs](https://example.com)");
        check(spans.getFirst().bold(), "bold");
        check(spans.stream().anyMatch(s -> s.italic() && s.text().equals("italic")), "italic");
        check(spans.stream().anyMatch(s -> s.code() && s.text().equals("a_b")), "code underscores");
        check(spans.stream().anyMatch(s -> "https://example.com".equals(s.link())), "link target preserved");
        check(JournalMarkdown.inline("file_name_here").stream().noneMatch(s -> s.italic()), "underscores inside words");
        check(JournalMarkdown.inline("\\*literal\\*").getFirst().text().equals("*literal*"), "escaped markers");
        var random = new java.util.Random(7);
        String alphabet = "ab *_~`[]()\\#|\n";
        for (int i = 0; i < 2000; i++) {
            var stream = new StringBuilder();
            for (int j = 0; j < 80; j++) stream.append(alphabet.charAt(random.nextInt(alphabet.length())));
            JournalMarkdown.blocks(stream.toString()); JournalMarkdown.inline(stream.toString());
        }
        System.out.println("Markdown checks passed: headings, lists, code, streaming, tables, inline styles and links.");
    }
    private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); }
}
