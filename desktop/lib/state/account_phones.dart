import 'dart:async';

import 'package:flutter/foundation.dart';

import 'app_state.dart';

/// Whether the account already has a phone — which decides whether the tab row
/// offers Add Phone's icon ([showsAddPhone]).
///
/// ⚠️ **The icon goes once the account has a phone (owner, 2026-10-13).** The
/// tab row is for what is used every day; a phone is added once, and after
/// that the icon would only sit there taking room. Hidden, the row is tidier.
///
/// **By the account, not by this computer.** A phone signed in to the account
/// finds every computer on it by itself, so a second or a third computer has no
/// phone to add either — its icon goes too, though Add Phone was never opened
/// there.
///
/// When the icon shows, and when it does not:
/// - **Hidden** while the account has any device that is not a computer and not
///   this end: a phone. The device log calls phones and browsers alike
///   `viewer`, so a browser signed in to the account counts as one too.
/// - **Shown** while the account has only computers on it.
/// - **Shown** while that is not known: before the list can be read (no daemon
///   yet), when the read fails, or with a daemon that predates `/api/devices`.
///   A way in stays rather than vanish on a guess.
/// - **Back by itself** when the account's last phone goes (Remove in Machines,
///   or the phone signing out): every change to the account's devices
///   ([AppNotifier.devicesRevision]) reads the list again.
/// - **Forgotten** on sign-out and when the account changes, then read again for
///   the next one.
///
/// Adding a second phone does not need the icon: Harness ▸ Add Phone…, the
/// account menu, `> add phone` and Add phone at the foot of Machines all open
/// Add Phone whatever this says.
class AccountPhones extends ChangeNotifier {
  AccountPhones(this.app) {
    app.addListener(_appChanged);
    _appChanged();
  }

  final AppNotifier app;

  /// Null while not known.
  bool? _has;

  /// Whether the tab row shows Add Phone's icon: not once the account is known
  /// to have a phone.
  bool get showsAddPhone => _has != true;

  /// The account and the devices' revision the answer is wanted for; null
  /// while there is nothing to read.
  ({String account, int revision})? _wanted;
  bool _reading = false;
  bool _disposed = false;

  ({String account, int revision})? get _current {
    if (app.isGuest || app.signingIn || !app.accountDevicesReadable) {
      return null;
    }
    final email = app.currentUser?.email.trim();
    // `CurrentUserProfile.local()` says "local terminal": not an account.
    if (email == null || !email.contains('@')) return null;
    return (account: email, revision: app.devicesRevision);
  }

  void _appChanged() {
    final wanted = _current;
    if (wanted == _wanted) return;
    // Another account's answer is not this one's: forgotten at once. The same
    // account's keeps showing until its new read lands, so the icon does not
    // blink in and out on every change to the list.
    if (wanted?.account != _wanted?.account) _set(null);
    _wanted = wanted;
    if (wanted != null) unawaited(_read());
  }

  /// One read at a time; one that lands after what is wanted moved on reads
  /// again for that, rather than say something about a list that is gone.
  Future<void> _read() async {
    if (_reading) return;
    _reading = true;
    try {
      while (!_disposed) {
        final asked = _wanted;
        if (asked == null) return;
        bool? has;
        try {
          final listing = await app.loadDevices();
          has = listing?.devices.any((d) => !d.isMachine && !d.self);
        } catch (_) {
          // Unreadable now: what was known stays, and the next change reads.
          has = null;
        }
        if (_disposed) return;
        if (asked != _wanted) continue;
        if (has != null) _set(has);
        return;
      }
    } finally {
      _reading = false;
    }
  }

  void _set(bool? has) {
    if (_has == has) return;
    _has = has;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    app.removeListener(_appChanged);
    super.dispose();
  }
}
