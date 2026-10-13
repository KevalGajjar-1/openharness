import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/output_check.dart';

/// The website's own cases (website/src/lib/community/outputCheck.spec.ts), run against the copy.
void main() {
  test('names files and addresses the Hub preview cannot reach', () {
    const html = '''<link rel="stylesheet" href="style.css"><link rel="icon" href="favicon.ico">
      <script type="module" src='./app.js'></script><img src=https://cdn.example/logo.png>
      <style>@import "fonts.css"; body { background: url(bg.png) }</style><a href="other.html">More</a>''';
    expect(outsideResources(html), [
      './app.js',
      'https://cdn.example/logo.png',
      'style.css',
      'bg.png',
      'fonts.css',
    ]);
  });
  test('a page that carries everything inside it loads nothing', () {
    expect(
      outsideResources(
        '<style>i{background:url("data:image/png;base64,AA==")}</style><img src="data:image/png;base64,AA=="><script>go()</script><a href="#top">Top</a>',
      ),
      isEmpty,
    );
  });
}
