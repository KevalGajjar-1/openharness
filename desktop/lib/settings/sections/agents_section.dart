import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../agent_settings.dart';

/// Settings ▸ Agents: what the agents on this computer may do with Harness itself.
class AgentsSection extends StatefulWidget {
  const AgentsSection({super.key, required this.store});

  final AgentSettingsStore store;

  @override
  State<AgentsSection> createState() => _AgentsSectionState();
}

class _AgentsSectionState extends State<AgentsSection> {
  @override
  void initState() {
    super.initState();
    unawaited(widget.store.refresh());
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
