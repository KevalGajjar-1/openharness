import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

/// What the person lets agents do with Harness on this computer — Settings ▸ Agents. This
/// computer's daemon keeps them (`/api/agent-settings`, cli/src/lib/agentSettings.ts), not the
/// account: each computer decides for the agents it runs.
enum AgentSetting {
  agentsStartAgents(
    'agentsStartAgents',
    'Agents can start other agents',
    'Claude Code and Codex can start, wait for and close harnesses of their own, and their '
        'instructions say how. Turn off to keep every agent working alone.',
  ),
  pullRequestLine(
    'pullRequestLine',
    'Mark pull requests from agent-started harnesses',
    'A harness another agent started adds one line to the pull requests it opens: '
        '🤝 Started by another agent in Harness.',
  );

  const AgentSetting(this.key, this.label, this.description);

  /// Its name in the daemon's settings.
  final String key;
  final String label, description;
}

/// Reads this computer's agent settings; null when its daemon predates them.
typedef AgentSettingsRead = Future<Map<String, dynamic>?> Function();

/// Changes one; answers the settings as they are afterwards.
typedef AgentSettingsWrite = Future<Map<String, dynamic>> Function(
  String key,
  bool value,
);

/// Settings ▸ Agents, read from and written to this computer's daemon. A change shows once the
/// daemon has answered with it, never before. A setting the daemon does not name is one it predates:
/// it is not offered, rather than shown in a state nobody can vouch for.
class AgentSettingsStore extends ChangeNotifier {
  AgentSettingsStore({this.read, this.write, this.unavailable});

  /// The settings through [api] — this computer's daemon.
  factory AgentSettingsStore.api(ApiClient api) =>
      AgentSettingsStore(read: api.agentSettings, write: api.setAgentSetting);

  final AgentSettingsRead? read;
  final AgentSettingsWrite? write;

  /// Why these cannot be changed from here at all (a browser has no daemon of its own). Null where
  /// they can.
  final String? unavailable;

  final _values = <AgentSetting, bool>{};
  bool loaded = false, saving = false, _disposed = false;

  /// Bumped by every read and write: an answer is taken only while its own is the latest, so a
  /// change the person starts wins over any read already under way.
  int _generation = 0;

  /// The generation of the read under way, while it is the latest.
  int? _reading;

  /// Why the last read or write failed, or why there is nothing to read.
  String? error;

  /// The read failed, or the daemon predates these settings: nothing can be changed until it answers.
  bool get blocked => unavailable != null || (!loaded && error != null);
  AgentSetting? savingSetting, errorSetting;

  /// The value the daemon last answered for [setting]; null before it has, or when it does not keep it.
  bool? value(AgentSetting setting) => _values[setting];

  /// Whether this computer keeps [setting]. The first one is always offered, if only to say why it
  /// cannot be changed here.
  bool offered(AgentSetting setting) =>
      setting == AgentSetting.agentsStartAgents || _values.containsKey(setting);

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _take(Map<String, dynamic> answer) {
    for (final setting in AgentSetting.values) {
      final value = answer[setting.key];
      if (value is bool) {
        _values[setting] = value;
      } else {
        _values.remove(setting);
      }
    }
  }

  static String _message(Object failure) => failure is ApiException
      ? failure.message
      : 'Couldn’t reach Harness on this computer. Check that it is running, then refresh.';

  static const _predates = 'Update Harness on this computer to change this.';

  Future<void> refresh() async {
    final read = this.read;
    // A read under way while a change is saved would drop the change's answer.
    if (_disposed || saving || unavailable != null || read == null) return;
    final generation = _reading = ++_generation;
    error = null;
    errorSetting = null;
    _changed();
    try {
      final answer = await read();
      if (_disposed || generation != _generation) return;
      if (answer == null) {
        loaded = false;
        _values.clear();
        error = _predates;
      } else {
        _take(answer);
        loaded = true;
      }
    } catch (failure) {
      if (_disposed || generation != _generation) return;
      error = _message(failure);
    } finally {
      if (_reading == generation) _reading = null;
    }
    _changed();
  }

  /// Reads the settings again without a word, for a page left open while something else changes
  /// them: `harness settings` in a terminal, an agent, another window. Nothing shows until the
  /// daemon answers, and then only a difference — a value, or a page that could not read them
  /// and now can. A read that fails leaves the page as it was: Refresh and the switches say why.
  ///
  /// It never fights the person: not while a change is saved or another read is under way, and a
  /// change started while it waits wins ([_generation]).
  Future<void> recheck() async {
    final read = this.read;
    if (_disposed ||
        saving ||
        _reading == _generation ||
        unavailable != null ||
        read == null) {
      return;
    }
    final generation = _reading = ++_generation;
    try {
      final answer = await read();
      if (_disposed || generation != _generation) return;
      if (answer == null) {
        // The daemon went back to one that predates these: say so, as a refresh would.
        if (!loaded && error == _predates) return;
        loaded = false;
        _values.clear();
        error = _predates;
        errorSetting = null;
      } else {
        final before = Map.of(_values);
        final wasLoaded = loaded;
        // A failed read said so under the first row; this one answered. A failed CHANGE keeps its
        // line under its own row until the person acts.
        final readFailed = error != null && errorSetting == null;
        _take(answer);
        loaded = true;
        if (readFailed) error = null;
        if (wasLoaded && !readFailed && mapEquals(before, _values)) return;
      }
      _changed();
    } catch (_) {
      // Quiet: the last answer stands.
    } finally {
      if (_reading == generation) _reading = null;
    }
  }

  Future<void> set(AgentSetting setting, bool on) async {
    final write = this.write;
    if (_disposed || saving || blocked || write == null || !loaded) return;
    final generation = ++_generation;
    saving = true;
    savingSetting = setting;
    error = null;
    errorSetting = null;
    _changed();
    try {
      final answer = await write(setting.key, on);
      if (_disposed || generation != _generation) return;
      _take(answer);
    } catch (failure) {
      if (_disposed || generation != _generation) return;
      error = _message(failure);
      errorSetting = setting;
    } finally {
      if (!_disposed && generation == _generation) {
        saving = false;
        savingSetting = null;
      }
    }
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
