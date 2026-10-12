// A harness another harness's agent started (`harness new`, `harness_start`
// from its pane) opens as a pane beside it, in the same tab, marked with who
// started it (owner, 2026-10-11; docs/design/2026-10-11-agent-client.md, "The
// person sees it"). Only one first seen live: never on a restore, never again
// after the person closed it, never a stopped one.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/started_children.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;

/// The machine as the daemon answers it: its list, and nothing else asked of it.
class _Machine extends WsConn {
  _Machine()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  List<Map<String, dynamic>> listed = [_agent('a0', name: 'lead')];

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<void> connect() async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agents_list' ? {'agents': listed} : {};
}

Map<String, dynamic> _agent(
  String id, {
  String? name,
  String? parent,
  DateTime? createdAt,
  String status = 'active',
}) => {
  'id': id,
  'name': name ?? id,
  'engine': parent == null ? 'codex' : 'claude',
  'status': status,
  'createdAt': (createdAt ?? DateTime.now()).toUtc().toIso8601String(),
  'terminal': {'available': true, 'primary': '', 'runtimes': []},
  'parentAgentId': parent,
};

Future<void> _push(AppNotifier app, Map<String, dynamic> agent) =>
    app.handleMachineEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': agent},
    });

List<String?> _agents(Swarm tab) => tab.panes.map((p) => p.agentId).toList();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a harness its agent started opens right beside it, in its tab, and takes nothing from the person', () async {
    final machine = _Machine();
    final app = createApp(connectionForTest: (_) => machine, connected: true);
    addTearDown(app.dispose);
    machine.listed = [
      _agent('a0', name: 'lead'),
      _agent('a1', name: 'notes'),
      _agent('a2', name: 'elsewhere'),
    ];
    await app.reloadMachineData('m');
    await app.addAgentToSwarm('m', 'a0');
    await app.addAgentToSwarm('m', 'a1');
    final work = app.activeSwarm;
    app.newSwarm(name: 'Other');
    await app.addAgentToSwarm('m', 'a2');
    final other = app.activeSwarm;
    final focused = app.focusedPane;

    await _push(app, _agent('kid', name: 'python-opinion', parent: 'a0'));
    expect(_agents(work), ['a0', 'kid', 'a1']);
    // The person stays where they are: the tab in front, its focus.
    expect(app.activeSwarm, same(other));
    expect(app.focusedPane, same(focused));
    final kid = work.panes.singleWhere((p) => p.agentId == 'kid');
    expect(work.focusedPaneId, isNot(kid.id));

    // The next frames of it change nothing; it is one pane.
    await _push(app, _agent('kid', name: 'python-opinion', parent: 'a0'));
    expect(_agents(work), ['a0', 'kid', 'a1']);
    expect(app.allPanes.where((p) => p.agentId == 'kid'), hasLength(1));
  });

  test('in the tab in front when that one shows the starter too', () async {
    final machine = _Machine();
    final app = createApp(connectionForTest: (_) => machine, connected: true);
    addTearDown(app.dispose);
    await app.reloadMachineData('m');
    await app.addAgentToSwarm('m', 'a0');
    final first = app.activeSwarm;
    app.newSwarm(name: 'Second');
    await app.addAgentToSwarm('m', 'a0');
    final second = app.activeSwarm;

    await _push(app, _agent('kid', parent: 'a0'));
    expect(_agents(second), ['a0', 'kid']);
    expect(_agents(first), ['a0']);
  });

  test('a list that brings it first places it too, once the window has read one', () async {
    final machine = _Machine();
    final app = createApp(connectionForTest: (_) => machine, connected: true);
    addTearDown(app.dispose);
    await app.reloadMachineData('m');
    await app.addAgentToSwarm('m', 'a0');
    machine.listed = [...machine.listed, _agent('kid', parent: 'a0')];
    await app.reloadMachineData('m');
    expect(_agents(app.activeSwarm), ['a0', 'kid']);
  });

  test('not on restore: what the first list brings stays where it was', () async {
    final storage = MemoryStore();
    await PaneLayoutStore(storage: storage).saveSwarms([
      Swarm(id: 'work', name: 'Work')
        ..panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'a0')),
    ], 'work');
    final machine = _Machine()
      ..listed = [_agent('a0', name: 'lead'), _agent('kid', parent: 'a0')];
    final app = createApp(
      store: storage,
      connectionForTest: (_) => machine,
    );
    addTearDown(app.dispose);
    await app.restorePaneLayoutForTest();
    // A push before the window has read the list is the restore too.
    await _push(app, _agent('early', parent: 'a0'));
    await app.reloadMachineData('m');
    await _push(app, _agent('kid', parent: 'a0'));
    await _push(app, _agent('early', parent: 'a0'));
    expect(_agents(app.activeSwarm), ['a0']);
    expect(app.stateOf('m')!.agents.map((a) => a.id), contains('kid'));
  });

  test('not again after the person closes it', () async {
    final machine = _Machine();
    final app = createApp(connectionForTest: (_) => machine, connected: true);
    addTearDown(app.dispose);
    await app.reloadMachineData('m');
    await app.addAgentToSwarm('m', 'a0');
    await _push(app, _agent('kid', parent: 'a0'));
    expect(_agents(app.activeSwarm), ['a0', 'kid']);

    await app.closePane(app.paneOfAgent('m', 'kid')!.id);
    expect(_agents(app.activeSwarm), ['a0']);
    await _push(app, _agent('kid', name: 'renamed', parent: 'a0'));
    machine.listed = [...machine.listed, _agent('kid', parent: 'a0')];
    await app.reloadMachineData('m');
    // Stopped and started again, it is still the one the person closed.
    await app.handleMachineEventForTest('m', {
      'type': 'agent_deleted',
      'payload': {'agentId': 'kid'},
    });
    await _push(app, _agent('kid', parent: 'a0'));
    expect(_agents(app.activeSwarm), ['a0']);
  });

  test('nothing new for a stopped one, an old one, one whose starter is in no tab, or the person\'s own', () async {
    final machine = _Machine();
    final app = createApp(connectionForTest: (_) => machine, connected: true);
    addTearDown(app.dispose);
    await app.reloadMachineData('m');
    await app.addAgentToSwarm('m', 'a0');
    await _push(app, _agent('stopped', parent: 'a0', status: 'stopped'));
    await _push(
      app,
      _agent(
        'old',
        parent: 'a0',
        createdAt: DateTime.now().subtract(const Duration(minutes: 30)),
      ),
    );
    await _push(app, _agent('orphan', parent: 'a9'));
    await _push(app, _agent('persons'));
    expect(_agents(app.activeSwarm), ['a0']);
    expect(
      app.stateOf('m')!.agents.map((a) => a.id),
      containsAll(['stopped', 'old', 'orphan', 'persons']),
    );
  });

  test('where it opens, decided from the tabs alone', () {
    final now = DateTime.utc(2026, 10, 11, 12);
    Agent child({String? parent = 'lead', DateTime? at}) => Agent(
      id: 'kid',
      name: 'kid',
      engine: 'claude',
      terminalAvailable: true,
      parentAgentId: parent,
      createdAt: at ?? now,
    );
    TerminalPane pane(int id, String agentId, {String machineId = 'm'}) =>
        TerminalPane(id: id, machineId: machineId, agentId: agentId);
    final store = Swarm(id: 'store', kind: 'store')..panes.add(pane(1, 'lead'));
    final full = Swarm(id: 'full')
      ..panes.addAll([pane(2, 'lead'), pane(3, 'x')]);
    final work = Swarm(id: 'work')..panes.add(pane(4, 'lead'));
    final elsewhere = Swarm(id: 'elsewhere')
      ..panes.add(pane(5, 'lead', machineId: 'other'));
    ({Swarm tab, TerminalPane parent})? place(
      Iterable<Swarm> tabs,
      Agent agent, {
      Swarm? active,
    }) => startedChildPlacement(
      tabs: tabs,
      activeTab: active ?? tabs.first,
      machineId: 'm',
      child: agent,
      now: now,
      maxPanes: 2,
    );

    // Not a tab for harnesses, nor a full one: the next that shows it.
    expect(place([store, full, work], child())?.tab, same(work));
    expect(place([store, full, work], child())?.parent.id, 4);
    // The same agent id on another machine is another harness.
    expect(place([elsewhere], child()), isNull);
    expect(place([work], child(parent: null)), isNull);
    expect(
      place([work], child(at: now.subtract(const Duration(minutes: 6)))),
      isNull,
    );
    // A clock a little ahead on the child's machine is still now.
    expect(
      place([work], child(at: now.add(const Duration(minutes: 1))))?.tab,
      same(work),
    );
    // Already in a tab here (the desk brought it from another computer).
    final shown = Swarm(id: 'shown')
      ..panes.addAll([pane(6, 'lead'), pane(7, 'kid')]);
    expect(place([shown, work], child()), isNull);
    expect(startedChildLive(child()), isTrue);
    expect(
      startedChildLive(
        Agent(
          id: 'kid',
          name: 'kid',
          parentAgentId: 'lead',
          terminalAvailable: true,
          launchState: 'failed',
        ),
      ),
      isFalse,
    );
  });

  for (final brightness in Brightness.values) {
    testWidgets('its header says who started it, by that harness\'s name now '
        '(${brightness.name})', (tester) async {
      tester.view.physicalSize = const Size(1400, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [
        ...app.stateOf('m')!.agents,
        const Agent(
          id: 'kid',
          name: 'python-opinion',
          engine: 'claude',
          terminalAvailable: true,
          parentAgentId: 'a0',
        ),
      ];
      final session = TerminalSession(
        machineId: 'm',
        agentId: 'kid',
        agentName: 'python-opinion',
        engineId: 'claude',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )..status = TerminalSessionStatus.controlling;
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          // The grid rebuilds its panes as the app changes; so does this.
          home: Scaffold(
            body: ListenableBuilder(
              listenable: app,
              builder: (context, _) => TerminalPanel(
                notifier: app,
                session: session,
                focused: false,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(
        find.textContaining('started by Agent 0', findRichText: true),
        findsOneWidget,
      );

      // Renamed since: the header follows.
      await app.handleMachineEventForTest('m', {
        'type': 'agent_renamed',
        'payload': {'agentId': 'a0', 'name': 'lead'},
      });
      await tester.pump();
      expect(
        find.textContaining('started by lead', findRichText: true),
        findsOneWidget,
      );
      session.dispose();
    });
  }
}
