import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../agent_settings.dart';

/// Settings ▸ Agents: what the agents on this computer may do with Harness itself.
///
/// The daemon keeps these, and `harness settings` changes them from a terminal without telling
/// anyone, so the page reads them again while it can be seen: every [recheckEvery], and as soon as
/// the window comes back to the front. A hidden or minimised window asks nothing.
class AgentsSection extends StatefulWidget {
  const AgentsSection({
    super.key,
    required this.store,
    this.recheckEvery = const Duration(seconds: 5),
  });

  final AgentSettingsStore store;

  /// How often the open page reads the settings again while the window can be seen.
  final Duration recheckEvery;

  @override
  State<AgentsSection> createState() => _AgentsSectionState();
}

class _AgentsSectionState extends State<AgentsSection> {
  late final AppLifecycleListener _lifecycle;
  Timer? _recheck;

  @override
  void initState() {
    super.initState();
    unawaited(widget.store.refresh());
    _lifecycle = AppLifecycleListener(
      // Back in front: whatever changed meanwhile, at once.
      onResume: () => unawaited(widget.store.recheck()),
      onStateChange: _watch,
    );
    _watch(WidgetsBinding.instance.lifecycleState);
  }

  /// Rechecks on a timer while the window can be seen — in front, or beside the terminal
  /// the change is typed in (inactive) — and not while it is hidden. An unknown state is seen.
  void _watch(AppLifecycleState? state) {
    final seen =
        state == null ||
        state == AppLifecycleState.resumed ||
        state == AppLifecycleState.inactive;
    if (!seen || widget.store.unavailable != null) {
      _recheck?.cancel();
      _recheck = null;
    } else {
      _recheck ??= Timer.periodic(
        widget.recheckEvery,
        (_) => unawaited(widget.store.recheck()),
      );
    }
  }

  @override
  void dispose() {
    _recheck?.cancel();
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    return SectionScaffold(
      title: 'Agents',
      subtitle: 'What the agents on this computer may do with Harness. Each computer keeps its own.',
      child: SingleChildScrollView(
        child: ListenableBuilder(
          listenable: store,
          builder: (context, _) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 10,
            children: [
              for (final setting in AgentSetting.values)
                if (store.offered(setting)) _row(store, setting),
            ],
          ),
        ),
      ),
    );
  }

  Widget _row(AgentSettingsStore store, AgentSetting setting) {
    final first = setting == AgentSetting.values.first;
    // Why nothing here can change: said once, under the first row.
    final reason = first
        ? store.unavailable ?? (store.errorSetting == null ? store.error : null)
        : null;
    final failed = store.errorSetting == setting ? store.error : null;
    return SettingRow(
      key: ValueKey('agent-setting-${setting.key}'),
      title: setting.label,
      detail: setting.description,
      control: Semantics(
        label: setting.label,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Switch(
            key: ValueKey('agent-setting-switch-${setting.key}'),
            // Until the daemon answers, the default: agents may.
            value: store.value(setting) ?? true,
            onChanged: store.loaded && !store.saving && !store.blocked
                ? (on) => unawaited(store.set(setting, on))
                : null,
          ),
        ),
      ),
      footer: store.savingSetting == setting
          ? Semantics(liveRegion: true, child: const Text('Saving…'))
          : reason != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  liveRegion: true,
                  child: Text(reason, key: const Key('agent-settings-reason')),
                ),
                if (store.unavailable == null)
                  TextButton(
                    onPressed: () => unawaited(store.refresh()),
                    child: const Text('Refresh setting'),
                  ),
              ],
            )
          : failed != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  liveRegion: true,
                  child: Text(failed, key: const Key('agent-settings-error')),
                ),
                TextButton(
                  onPressed: () => unawaited(store.refresh()),
                  child: const Text('Refresh setting'),
                ),
              ],
            )
          : first && !store.loaded && store.error == null
          ? const Text('Loading…')
          : null,
    );
  }
}
