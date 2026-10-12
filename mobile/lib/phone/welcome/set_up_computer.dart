import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'scan_to_connect.dart' show kAddPhoneWhere;

/// Where Harness is downloaded: the website's download page, which offers each computer its own
/// file — the Mac's, Linux's, the command line's.
const kDesktopDownloadUrl = 'https://harness.autonomous.ai/desktop';

/// Where everything on Connect your computer starts, from either side: wider than the terminal's
/// [Tty.origin], since the page is read, top to bottom, not scanned.
const double _gutter = 20;

/// **Connect your computer** — the page a phone with no computer stands on: signed out (the first
/// screen, `phone_welcome.dart`), signed in to an account with none (`connect_computer.dart`), and
/// Computers ▸ Set up another computer. What Harness on a phone is for, one button, and the steps on
/// the computer — the first with the way for somebody who has no Harness there yet ([GetHarnessPage]).
///
/// ```
/// harness▌                         (⚙ once signed in: Settings)
///
/// Your agents                      (from Computers: Set up another computer)
/// in your pocket.
/// See every session on your machines. Answer your agents from anywhere.
/// [status]
/// [ ⊞  Connect computer              ]
///
/// ① Open Harness on your computer
/// │ Don’t have it? Get it ›
/// ② Sign in on your computer
/// │ With ada@gmail.com.             (signed in only: which account)
/// ③ Click Add Phone
///   Mac: Harness menu
///   Linux: Ctrl+Shift+P → add phone
/// ```
///
/// ⚠️ **One edge (owner, 2026-10-11).** Everything starts at [_gutter] — the wordmark, the words,
/// the button (the page's width) and the steps' numbers. The title, a 300-wide button and "No
/// Harness yet? Get it ›" used to be centred over steps that started at the edge, and the page read
/// as stepping in and out. The words are the desktop's, cut down (`setup_tour.dart`, "Your agents
/// in your pocket."): the page used to say "Harness" without ever saying what it was.
///
/// Nothing else on it, signed out: the other ways to sign in are the camera's "Can’t scan?", where
/// a computer with no code or a phone with no camera finds out it needs them, and the sample is
/// Get it's, for somebody waiting on the computer (owner, 2026-10-09).
///
/// Short on purpose (owner, 2026-10-08): a line under a step only where the step cannot be done
/// without it — where to get Harness, where Add Phone is, which account.
///
/// ⚠️ **One button, after Orca's (owner, 2026-10-08).** The first screen used to ask "Is Harness on
/// your computer?" — Yes to the camera, Not yet to a page of download rows, steps and a second scan —
/// beside Google and Apple: six ways on before anything was explained. Somebody who has Harness
/// presses Connect computer; somebody who has not follows Get it, and comes back to the same button.
class SetUpComputerPage extends StatelessWidget {
  const SetUpComputerPage({
    super.key,
    required this.onScan,
    required this.onGetIt,
    this.onBack,
    this.status,
    this.account,
    this.watching = false,
    this.topTrailing,
    this.scanStatus,
  });

  /// Connect computer: the camera, for the code the computer's Add Phone shows — it pairs this phone
  /// with it (and, signed out, signs it in).
  final VoidCallback onScan;

  /// "No Harness yet? Get it ›" — [GetHarnessPage].
  final VoidCallback onGetIt;

  /// Null draws the wordmark instead of a back button: the page is a home screen, not a pushed one.
  final VoidCallback? onBack;

  /// Under the words, over the button: what is going on — the watch for the computer once signed
  /// in, or why the phone was signed out.
  final Widget? status;

  /// The account this phone is signed in to, when it is: the computer has to sign in to the same
  /// one, and the first step says so by name.
  final String? account;

  /// Whether the page is watching the account for the computer (signed in, at home): it then
  /// shows up by itself, with no code.
  final bool watching;

  /// At the right of the top row, across from the wordmark or `‹ Back` — Settings
  /// (`PhoneSettingsButton`) once signed in.
  final Widget? topTrailing;

  /// What the last scan came to — pairing, or why it did not — right under Connect computer, the
  /// button that started it.
  final Widget? scanStatus;

  /// The steps after the first (Harness on the computer, with Get it) — [_stepsAfterOpening], the
  /// same signed in or out; only the line under signing in differs: none signed out, the account
  /// signed in.
  List<({String title, String? note})> get _nextSteps =>
      _stepsAfterOpening(switch (account) {
        null => null,
        // At home the line over the button names the account already.
        _ when watching => 'With the same account.',
        // From Computers nothing above names it.
        final account => 'With $account.',
      });

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final next = _nextSteps;
    // A tablet's width would stretch the button across the screen: a phone's column, centred.
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // One row whatever is in it: the back button's height, so the page starts at the same
            // place with a back or the wordmark, a trailing control or none.
            SizedBox(
              height: 44,
              child: Row(
                children: [
                  if (onBack case final onBack?)
                    // Its chevron sits at the terminal's origin: over to the page's edge.
                    Padding(
                      padding: const EdgeInsets.only(
                        left: _gutter - Tty.origin,
                      ),
                      child: TtyBackButton(onPressed: onBack),
                    )
                  else
                    const Padding(
                      padding: EdgeInsets.only(left: _gutter),
                      child: _Wordmark(),
                    ),
                  const Spacer(),
                  ?topTrailing,
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(_gutter, 36, _gutter, 28),
                children: [
                  // From Computers the agents are on this phone already: the page is the row that
                  // was pressed.
                  if (onBack == null)
                    const _Hero(
                      title: 'Your agents\nin your pocket.',
                      body:
                          'See every session on your machines. '
                          'Answer your agents from anywhere.',
                      start: true,
                    )
                  else
                    const _Hero(title: 'Set up another computer', start: true),
                  if (status case final status?) ...[
                    const SizedBox(height: 18),
                    status,
                  ],
                  const SizedBox(height: 28),
                  TtyPrimaryButton(
                    key: const ValueKey('set-up-scan'),
                    icon: LucideIcons.qrCode300,
                    label: 'Connect computer',
                    onPressed: onScan,
                  ),
                  if (scanStatus case final scanStatus?) ...[
                    const SizedBox(height: 10),
                    scanStatus,
                  ],
                  const SizedBox(height: 36),
                  // Get it where Harness is first said: it used to be a line of its own under the
                  // steps, centred, for a question the first step raises.
                  _HowItWorksRow(
                    number: 1,
                    title: _openHarness,
                    link: _StepLink(
                      key: const ValueKey('set-up-get-it'),
                      lead: 'Don’t have it? ',
                      action: 'Get it ›',
                      onTap: onGetIt,
                    ),
                  ),
                  for (final (i, step) in next.indexed)
                    _HowItWorksRow(
                      number: i + 2,
                      title: step.title,
                      note: step.note,
                      last: i == next.length - 1,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// **Get it** — Harness onto the computer, from the phone: the download page's address, to type
/// into the computer's browser (a phone cannot install it), then back to Connect computer.
///
/// ```
/// ‹
/// Get Harness
/// on your computer
/// In your computer’s browser, go to:
/// ┌───────────────────────────────────┐
/// │   harness.autonomous.ai/desktop ⇪ │
/// └───────────────────────────────────┘
/// Or tap to send it with AirDrop or Messages.
///
/// ⋮
/// Installed? Connect computer ›         ← the foot of the screen: after the computer
/// Try the sample while you wait
/// ```
///
/// ⚠️ **The address is the page (owner, 2026-10-11).** It used to lead with "Send to my computer" —
/// the share sheet — over the address in small print, and somebody new did not know whom to send it
/// to. Typed, the address works on any computer. The share sheet is behind the address itself, for
/// AirDrop to a Mac beside you.
///
/// ⚠️ **But said, not left to be worked out (owner, 2026-10-12).** The title was "Open this on your
/// computer", with nothing between it and the address: it named neither what "this" was for nor
/// what to open it in, and somebody new read the address as a link to tap here. The title now says
/// what the page is for — Get it's own words — the line under it where, and a line under the
/// address what its glyph does, which nothing said either.
///
/// The page gives the website, not a file: it offers each computer its own download (Mac, Linux,
/// the command line), which a phone cannot tell apart.
class GetHarnessPage extends StatelessWidget {
  const GetHarnessPage({
    super.key,
    required this.onBack,
    required this.onPair,
    this.onTrySample,
  });

  final VoidCallback onBack;

  /// "Connect computer ›": the camera, the same as the button on [SetUpComputerPage].
  final VoidCallback onPair;

  /// The offline sample — what Harness is like, for somebody waiting on the computer to install.
  final VoidCallback? onTrySample;

  /// The share sheet with the download page: AirDrop to the Mac beside you, or Messages or email to
  /// yourself, opened on the computer. Anchored to the address for iPad, where the sheet is a popover.
  Future<void> _sendLink(BuildContext address) async {
    final box = address.findRenderObject() as RenderBox?;
    final origin = box == null || !box.attached
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
    try {
      await SharePlus.instance.share(
        ShareParams(
          uri: Uri.parse(kDesktopDownloadUrl),
          subject: 'Get Harness for your computer',
          sharePositionOrigin: origin,
        ),
      );
    } catch (_) {
      // No share sheet came up: the address is still there to type, and can be pressed again.
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    // What a tap on the address brings up, by its names here: there is no AirDrop off Apple.
    final shareHint = Theme.of(context).platform == TargetPlatform.iOS
        ? 'Or tap to send it with AirDrop or Messages.'
        : 'Or tap to send it to yourself.';
    // ⚠️ **One edge, the page it is opened from's (owner, 2026-10-12).** Connect your computer
    // starts everything at [_gutter] — its title, the button across the page, the steps — and this
    // page, centred at the terminal's origin, read as a different app one tap in. The same edge,
    // the same headline, the address across the page as the button is, and a tablet's phone column.
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              // Its chevron sits at the terminal's origin: over to the page's edge, as on Connect
              // your computer.
              child: Padding(
                padding: const EdgeInsets.only(left: _gutter - Tty.origin),
                child: TtyBackButton(onPressed: onBack),
              ),
            ),
            Expanded(
              // The links at the foot of the screen, apart from the address: they are for after the
              // computer, not now. A short screen scrolls instead.
              child: LayoutBuilder(
                builder: (context, box) => SingleChildScrollView(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      minHeight: box.hasBoundedHeight ? box.maxHeight : 0,
                    ),
                    child: IntrinsicHeight(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(
                          _gutter,
                          36,
                          _gutter,
                          20,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // What the page is for, in Get it's words; then where the address
                            // goes. Broken by hand, as the first screen's title is.
                            const _Hero(
                              title: 'Get Harness\non your computer',
                              body: 'In your computer’s browser, go to:',
                              start: true,
                            ),
                            const SizedBox(height: 28),
                            Builder(
                              builder: (address) => _AddressCard(
                                key: const ValueKey('get-it-send'),
                                address: kDesktopDownloadUrl.replaceFirst(
                                  'https://',
                                  '',
                                ),
                                onPressed: () => unawaited(_sendLink(address)),
                              ),
                            ),
                            const SizedBox(height: 10),
                            Text(
                              shareHint,
                              key: const ValueKey('get-it-share-hint'),
                              style: tty
                                  .style(color: tty.faint, size: TtySize.meta)
                                  .copyWith(height: 1.45),
                            ),
                            const Spacer(),
                            const SizedBox(height: 36),
                            // Nothing about signing in there: the desktop app asks for it itself,
                            // and opens Add Phone by itself once it is.
                            _TextLink(
                              key: const ValueKey('get-it-pair'),
                              lead: 'Installed? ',
                              action: 'Connect computer ›',
                              onTap: onPair,
                            ),
                            if (onTrySample case final onTrySample?)
                              _TextLink(
                                key: const ValueKey('get-it-sample'),
                                action: 'Try the sample while you wait',
                                onTap: onTrySample,
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A page's title and the sentence under it, when it has one: centred, or from the page's edge
/// ([start]) — larger there, where it is the page's headline (Connect your computer).
class _Hero extends StatelessWidget {
  const _Hero({required this.title, this.body, this.start = false});

  final String title;
  final String? body;
  final bool start;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final align = start ? TextAlign.start : TextAlign.center;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          textAlign: align,
          style: start
              ? tty
                    .style(size: 28, weight: FontWeight.w700)
                    .copyWith(height: 1.2, letterSpacing: -0.8)
              : tty
                    .style(size: 24, weight: FontWeight.w600)
                    .copyWith(height: 1.25, letterSpacing: -0.4),
        ),
        if (body case final body?) ...[
          const SizedBox(height: 12),
          Text(
            body,
            textAlign: align,
            style: tty.style(color: tty.faint, size: 14).copyWith(height: 1.55),
          ),
        ],
      ],
    );
  }
}

/// `harness▌`: the app's name and the terminal's cursor, where a home screen has no back.
class _Wordmark extends StatelessWidget {
  const _Wordmark();

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        TtyText('harness', size: TtySize.row, weight: FontWeight.w600),
        Container(
          width: 8,
          height: 16,
          margin: const EdgeInsets.only(left: 2),
          color: tty.green,
        ),
      ],
    );
  }
}

/// The first step on the computer, signed in or out.
const _openHarness = 'Open Harness on your computer';

/// The steps after [_openHarness]: sign in on the computer, then Add Phone and where it is.
///
/// ⚠️ **One set, wherever they are shown (owner, 2026-10-12)** — the first screen, Set up another
/// computer, and Connect computer's camera from Computers. They used to be two: signed out "Click
/// Add Phone ③ Scan the QR code", signed in "Sign in on your computer ③ Not showing up? Click Add
/// Phone" — one button on one page, and steps that changed under it, and on the camera "Not showing
/// up?" was asked of somebody already scanning. Both halves hold either way: Add Phone asks a
/// computer that is not signed in to sign in before it shows a code, and a computer that turns up
/// by itself is paired just as well by its code. The scan is the button above the steps, and the
/// camera's own title, so it is not a step of its own.
///
/// [signIn]: under signing in, which account — the phone's, when it has one to name. Null signed
/// out, where the scan signs the phone in to whichever account the computer has.
List<({String title, String? note})> _stepsAfterOpening(String? signIn) => [
  (title: 'Sign in on your computer', note: signIn),
  (title: 'Click Add Phone', note: kAddPhoneWhere),
];

/// The steps on the computer under Connect computer's camera, opened from Computers — where the
/// page it came from says none of them ([ScanToConnectPage.steps]).
///
/// Set up another computer's own steps, word for word, so the two pages say one thing; without its
/// Get it, which is that page's — Connect computer is for a computer that has Harness, and the row
/// for one that has not is right under the button.
class ComputerSteps extends StatelessWidget {
  const ComputerSteps({super.key, required this.account});

  /// This phone's account, named in the sign-in step.
  final String? account;

  @override
  Widget build(BuildContext context) {
    final account = this.account;
    final next = _stepsAfterOpening(account == null ? null : 'With $account.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const _HowItWorksRow(number: 1, title: _openHarness),
        for (final (i, step) in next.indexed)
          _HowItWorksRow(
            number: i + 2,
            title: step.title,
            note: step.note,
            last: i == next.length - 1,
          ),
      ],
    );
  }
}

/// One step: its number in a ring, a thread down to the next one's, what to do, and under it a
/// quieter line when one is needed — or a link ([link]: Get it).
class _HowItWorksRow extends StatelessWidget {
  const _HowItWorksRow({
    required this.number,
    required this.title,
    this.note,
    this.link,
    this.last = false,
  });

  final int number;
  final String title;
  final String? note;
  final Widget? link;
  final bool last;

  static const double _ring = 24;

  /// Round a note, and a link: the same, so the steps stand the same distance apart either way.
  static const EdgeInsets noteInsets = EdgeInsets.only(top: 2, bottom: 6);

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final line = tty.dim.withValues(alpha: 0.6);
    // As tall as its words and the space under them, so the thread runs through that space to the
    // next ring.
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: _ring,
            child: Column(
              children: [
                Container(
                  width: _ring,
                  height: _ring,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: line),
                  ),
                  child: Text(
                    '$number',
                    style: tty.style(color: tty.faint, size: TtySize.meta),
                  ),
                ),
                if (!last)
                  Expanded(
                    child: Container(
                      width: 1,
                      margin: const EdgeInsets.symmetric(vertical: 6),
                      color: line,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: last ? 0 : 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Centred on the ring while it is one line; wraps under itself after.
                  ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: _ring),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        title,
                        style: tty.style(
                          size: TtySize.row,
                          weight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  if (note case final note?)
                    Padding(
                      padding: noteInsets,
                      child: Text(
                        note,
                        style: tty
                            .style(color: tty.faint, size: TtySize.meta)
                            .copyWith(height: 1.45),
                      ),
                    ),
                  ?link,
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A step's link, where its note would be — "Don’t have it? Get it ›": faint words, and the part
/// that acts in the terminal's green. All of it acts, with the space round it: one line of small
/// words is little to hit.
class _StepLink extends StatelessWidget {
  const _StepLink({
    super.key,
    required this.lead,
    required this.action,
    required this.onTap,
  });

  final String lead;
  final String action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: '$lead$action',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: Padding(
          padding: _HowItWorksRow.noteInsets.copyWith(right: 16),
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(text: lead),
                TextSpan(
                  text: action,
                  style: tty.style(
                    color: tty.green,
                    size: TtySize.meta,
                    weight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            style: tty
                .style(color: tty.faint, size: TtySize.meta)
                .copyWith(height: 1.45),
          ),
        ),
      ),
    );
  }
}

/// A small link from the page's edge: faint words, and the part that acts in the terminal's green —
/// "Installed? Connect computer ›". With no [lead] at all the whole link is the faint words ("Try
/// the sample while you wait"). Its touch room is round the words, but not before them: the words
/// start on the edge everything else does.
class _TextLink extends StatelessWidget {
  const _TextLink({
    super.key,
    required this.action,
    required this.onTap,
    this.lead,
  });

  final String? lead;
  final String action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final lead = this.lead;
    return Semantics(
      button: true,
      label: '${lead ?? ''}$action',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(0, 10, 8, 10),
            child: Text.rich(
              TextSpan(
                children: [
                  if (lead != null) TextSpan(text: lead),
                  TextSpan(
                    text: action,
                    style: lead == null
                        ? null
                        : tty.style(
                            color: tty.green,
                            size: TtySize.meta,
                            weight: FontWeight.w600,
                          ),
                  ),
                ],
              ),
              textAlign: TextAlign.start,
              style: tty.style(color: tty.faint, size: TtySize.meta),
            ),
          ),
        ),
      ),
    );
  }
}

/// The download page's address, big enough to read off the phone and type on the computer: the
/// page's one thing. Pressed, the share sheet — AirDrop to the Mac beside you, or a message to
/// yourself — which the icon at its right says.
class _AddressCard extends StatefulWidget {
  const _AddressCard({
    super.key,
    required this.address,
    required this.onPressed,
  });

  /// Without the scheme: what is typed.
  final String address;
  final VoidCallback onPressed;

  static const double _iconSize = 18;
  static const double _iconGap = 10;

  @override
  State<_AddressCard> createState() => _AddressCardState();
}

class _AddressCardState extends State<_AddressCard> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final raised = ttyRaised(tty);
    return Semantics(
      button: true,
      label: '${widget.address}, Send link',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _down = true),
        onTapCancel: () => setState(() => _down = false),
        onTapUp: (_) => setState(() => _down = false),
        onTap: () {
          HapticFeedback.selectionClick();
          widget.onPressed();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 20),
          decoration: BoxDecoration(
            color: _down
                ? Color.alphaBlend(tty.text.withValues(alpha: 0.06), raised)
                : raised,
            border: Border.all(color: tty.dim.withValues(alpha: 0.6)),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              // The icon's width on the left too, so the address sits in the middle of the card.
              const SizedBox(
                width: _AddressCard._iconSize + _AddressCard._iconGap,
              ),
              // One line on any phone: a narrow one shrinks it rather than breaking the address.
              Expanded(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    widget.address,
                    maxLines: 1,
                    softWrap: false,
                    style: tty.style(size: 17, weight: FontWeight.w600),
                  ),
                ),
              ),
              const SizedBox(width: _AddressCard._iconGap),
              Icon(
                LucideIcons.share300,
                size: _AddressCard._iconSize,
                color: tty.faint,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
