const _markdownDelimiters = ['***', '___', '**', '__', '~~', '*', '_'];

final _autolinkPattern = RegExp(
  r'<((?:https?://|buzz://(?:message\?|join\?|channel/))[^>]+)>',
);
final _bareLinkPattern = RegExp(
  r'(?<![(\]=])(?:https?://|buzz://(?:message\?|join\?|channel/))[^\s)>\]]+',
);
final _trailingPunctuationPattern = RegExp(r'[.,!?:;]+$');

/// Converts supported autolinks and bare links into Markdown links while
/// leaving inline and fenced code untouched.
String normalizeBareLinks(String content) {
  final buffer = StringBuffer();
  final backtickRuns = RegExp(r'`+').allMatches(content);
  var offset = 0;
  String? codeDelimiter;

  for (final run in backtickRuns) {
    if (codeDelimiter == null) {
      buffer.write(_normalizeLinkSegment(content.substring(offset, run.start)));
      codeDelimiter = run[0]!;
    } else {
      buffer.write(content.substring(offset, run.start));
      if (run[0] == codeDelimiter) {
        codeDelimiter = null;
      }
    }

    buffer.write(run[0]!);
    offset = run.end;
  }

  final trailing = content.substring(offset);
  buffer.write(
    codeDelimiter == null ? _normalizeLinkSegment(trailing) : trailing,
  );
  return buffer.toString();
}

String _normalizeLinkSegment(String segment) {
  var normalized = segment.replaceAllMapped(
    _autolinkPattern,
    (match) => '[${match[1]}](${match[1]})',
  );
  normalized = normalized.replaceAllMapped(
    _bareLinkPattern,
    (match) => _normalizeBareLink(normalized, match),
  );
  return normalized;
}

String _normalizeBareLink(String segment, Match match) {
  final matched = match[0]!;
  var url = matched;
  var trailing = '';
  final start = match.start;

  final outsidePunctuation = _trailingPunctuationPattern.firstMatch(url);
  if (outsidePunctuation != null) {
    url = url.substring(0, outsidePunctuation.start);
    trailing = outsidePunctuation[0]!;
  }

  var strippedDelimiter = true;
  while (strippedDelimiter) {
    strippedDelimiter = false;
    for (final delimiter in _markdownDelimiters) {
      if (url.endsWith(delimiter) &&
          _hasUnclosedMarkdownDelimiter(
            segment.substring(0, start),
            delimiter,
          )) {
        url = url.substring(0, url.length - delimiter.length);
        trailing = '$delimiter$trailing';
        strippedDelimiter = true;
        break;
      }
    }
  }

  final punctuation = _trailingPunctuationPattern.firstMatch(url);
  if (punctuation != null) {
    url = url.substring(0, punctuation.start);
    trailing = '${punctuation[0]}$trailing';
  }

  // Preserve a URL already used as its own Markdown label. This covers both
  // converted autolinks and authored `[url](url)` links.
  if (start >= 1 && segment[start - 1] == '[') return matched;
  return '[$url]($url)$trailing';
}

bool _hasUnclosedMarkdownDelimiter(String prefix, String delimiter) {
  var open = false;
  var offset = 0;
  while (true) {
    final index = prefix.indexOf(delimiter, offset);
    if (index < 0) return open;
    final before = index == 0 ? null : prefix[index - 1];
    final afterIndex = index + delimiter.length;
    final after = afterIndex == prefix.length ? null : prefix[afterIndex];
    final canOpen =
        (after == null || after.trim().isNotEmpty) &&
        (before == null ||
            before.trim().isEmpty ||
            RegExp(r'[^\w]').hasMatch(before));
    if (open || canOpen) open = !open;
    offset = afterIndex;
  }
}
