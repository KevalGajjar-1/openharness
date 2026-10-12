// Settings ▸ Agents: what the agents on this computer may do with Harness, kept by this computer's
// daemon (`/api/agent-settings`). The page shows a change once the daemon answers with it; a setting
// the daemon does not name (an older daemon) is not offered.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/agent_settings.dart';
import 'package:harness/settings/sections/agents_section.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// This computer's daemon, as far as the page can tell.
class _Daemon {
  _Daemon([Map<String, dynamic>? settings])
    : settings =
          settings ?? {'agentsStartAgents': true, 'pullRequestLine': true};

  Map<String, dynamic>? settings;
  Object? readError;
  Object? writeError;
  Completer<void>? readGate, writeGate;
  int reads = 0;
  final writes = <(String, bool)>[];

  /// What the file said when the read reached it, answered once [readGate] opens.
  Future<Map<String, dynamic>?> read() async {
    reads++;
    final answer = settings == null ? null : Map.of(settings!);
    await readGate?.future;
    if (readError case final error?) throw error;
    return answer;
  }

  Future<Map<String, dynamic>> write(String key, bool value) async {
    writes.add((key, value));
    await writeGate?.future;
    if (writeError case final error?) throw error;
    settings![key] = value;
    return Map.of(settings!);
  }

  AgentSettingsStore store() => AgentSettingsStore(read: read, write: write);
}

void main() {
  Future<AgentSettingsStore> open(
    WidgetTester tester,
    AgentSettingsStore store, {
    Duration recheckEvery = const Duration(seconds: 5),
  }) async {
    addTearDown(store.dispose);
    tester.view.physicalSize = const Size(1000, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AgentsSection(store: store, recheckEvery: recheckEvery),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return store;
  }

  Switch switchFor(WidgetTester tester, AgentSetting setting) =>
      tester.widget<Switch>(
        find.byKey(ValueKey('agent-setting-switch-${setting.key}')),
      );

  testWidgets('both rows load from the daemon, with their copy', (
    tester,
  ) async {
    final daemon = _Daemon({
      'agentsStartAgents': false,
      'pullRequestLine': true,
    });
    await open(tester, daemon.store());
    expect(find.text('Agents can start other agents'), findsOneWidget);
    expect(
      find.text(
        'Claude Code and Codex can start, wait for and close harnesses of their own, and their '
        'instructions say how. Turn off to keep every agent working alone.',
      ),
      findsOneWidget,
    );
    expect(
      find.text('Mark pull requests from agent-started harnesses'),
      findsOneWidget,
    );
    expect(
      find.text(
        'A harness another agent started adds one line to the pull requests it opens: '
        '🤝 Started by another agent in Harness.',
      ),
      findsOneWidget,
    );
    expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isFalse);
    expect(switchFor(tester, AgentSetting.pullRequestLine).value, isTrue);
    expect(daemon.reads, 1);
  });

  testWidgets(
    'a toggle sends only its key, and shows once the daemon says so',
    (tester) async {
      final daemon = _Daemon()..writeGate = Completer<void>();
      await open(tester, daemon.store());
      await tester.tap(
        find.byKey(const ValueKey('agent-setting-switch-agentsStartAgents')),
      );
      await tester.pump();
      expect(daemon.writes, [('agentsStartAgents', false)]);
      expect(find.text('Saving…'), findsOneWidget);
      // Not before the answer.
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isTrue);
      expect(
        switchFor(tester, AgentSetting.pullRequestLine).onChanged,
        isNull,
        reason: 'one change at a time',
      );
      daemon.writeGate!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Saving…'), findsNothing);
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isFalse);

      daemon.writeGate = null;
      await tester.tap(
        find.byKey(const ValueKey('agent-setting-switch-pullRequestLine')),
      );
      await tester.pumpAndSettle();
      expect(daemon.writes.last, ('pullRequestLine', false));
      expect(switchFor(tester, AgentSetting.pullRequestLine).value, isFalse);
    },
  );

  testWidgets('a failed change says why, keeps the value, and offers Refresh', (
    tester,
  ) async {
    final daemon = _Daemon()..writeError = ApiException('Nothing to change.');
    await open(tester, daemon.store());
    await tester.tap(
      find.byKey(const ValueKey('agent-setting-switch-agentsStartAgents')),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agent-settings-error')), findsOneWidget);
    expect(find.text('Nothing to change.'), findsOneWidget);
    expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isTrue);
    daemon.writeError = null;
    await tester.tap(find.text('Refresh setting'));
    await tester.pumpAndSettle();
    expect(daemon.reads, 2);
    expect(find.text('Nothing to change.'), findsNothing);
  });

  testWidgets(
    'a daemon that does not name pullRequestLine does not get its row',
    (tester) async {
      await open(tester, _Daemon({'agentsStartAgents': true}).store());
      expect(find.text('Agents can start other agents'), findsOneWidget);
      expect(
        find.text('Mark pull requests from agent-started harnesses'),
        findsNothing,
      );
    },
  );

  // Agent Messages left the tab for this row: the tab's 💬 was easy to hit by
  // mistake and turned the tab off, failing a waiting message (owner,
  // 2026-10-12).
  testWidgets('Agent Messages is one row, on by default, and a toggle writes '
      'agentMessages', (tester) async {
    final daemon = _Daemon({
      'agentsStartAgents': true,
      'pullRequestLine': true,
      'agentMessages': true,
    });
    await open(tester, daemon.store());
    expect(
      find.text('Agents in the same tab can message each other'),
      findsOneWidget,
    );
    expect(
      find.text(
        'Claude Code and Codex in one tab can send each other messages with '
        'harness send. Turn off to keep them from messaging.',
      ),
      findsOneWidget,
    );
    expect(switchFor(tester, AgentSetting.agentMessages).value, isTrue);
    await tester.tap(
      find.byKey(const ValueKey('agent-setting-switch-agentMessages')),
    );
    await tester.pumpAndSettle();
    expect(daemon.writes, [('agentMessages', false)]);
    expect(switchFor(tester, AgentSetting.agentMessages).value, isFalse);
    // Turned back on, as `harness settings agent-messages on` would.
    await tester.tap(
      find.byKey(const ValueKey('agent-setting-switch-agentMessages')),
    );
    await tester.pumpAndSettle();
    expect(daemon.writes.last, ('agentMessages', true));
    expect(switchFor(tester, AgentSetting.agentMessages).value, isTrue);
  });

  testWidgets(
    'a daemon that does not name agentMessages does not get its row',
    (tester) async {
      // A daemon from before the setting: it read each tab's own switch.
      await open(tester, _Daemon().store());
      expect(
        find.text('Mark pull requests from agent-started harnesses'),
        findsOneWidget,
      );
      expect(
        find.text('Agents in the same tab can message each other'),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('agent-setting-agentMessages')),
        findsNothing,
      );
    },
  );

  testWidgets('a daemon that predates the settings is told to update', (
    tester,
  ) async {
    final daemon = _Daemon()..settings = null;
    await open(tester, daemon.store());
    expect(
      find.text('Update Harness on this computer to change this.'),
      findsOneWidget,
    );
    expect(switchFor(tester, AgentSetting.agentsStartAgents).onChanged, isNull);
    expect(
      find.text('Mark pull requests from agent-started harnesses'),
      findsNothing,
    );
  });

  testWidgets('no daemon: disabled, with why and Refresh', (tester) async {
    final daemon = _Daemon()..readError = StateError('no daemon');
    await open(tester, daemon.store());
    expect(find.byKey(const Key('agent-settings-reason')), findsOneWidget);
    expect(find.textContaining('Couldn’t reach Harness'), findsOneWidget);
    expect(switchFor(tester, AgentSetting.agentsStartAgents).onChanged, isNull);
    daemon.readError = null;
    await tester.tap(find.text('Refresh setting'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agent-settings-reason')), findsNothing);
    expect(
      switchFor(tester, AgentSetting.agentsStartAgents).onChanged,
      isNotNull,
    );
    expect(
      find.text('Mark pull requests from agent-started harnesses'),
      findsOneWidget,
    );
  });

  group('while the page is open', () {
    const every = Duration(seconds: 5);

    /// Lets [time] pass, then the frames an answer arriving in it needs.
    Future<void> wait(
      WidgetTester tester, [
      Duration time = Duration.zero,
    ]) async {
      await tester.pump(time);
      await tester.pump();
      await tester.pump();
    }

    testWidgets('a change made elsewhere shows by the next read', (
      tester,
    ) async {
      final daemon = _Daemon();
      await open(tester, daemon.store(), recheckEvery: every);
      expect(daemon.reads, 1);
      // `harness settings pull-request-line off`, in a terminal.
      daemon.settings!['pullRequestLine'] = false;
      await wait(tester, every ~/ 2);
      expect(daemon.reads, 1);
      expect(switchFor(tester, AgentSetting.pullRequestLine).value, isTrue);
      await wait(tester, every ~/ 2);
      expect(daemon.reads, 2);
      expect(switchFor(tester, AgentSetting.pullRequestLine).value, isFalse);
      // Quietly: no Loading… between, and the switches stay live.
      expect(find.text('Loading…'), findsNothing);
      expect(
        switchFor(tester, AgentSetting.pullRequestLine).onChanged,
        isNotNull,
      );
      daemon.settings!['agentsStartAgents'] = false;
      await wait(tester, every);
      expect(daemon.reads, 3);
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isFalse);
    });

    testWidgets('coming back to the front reads again at once; hidden asks '
        'nothing', (tester) async {
      final daemon = _Daemon();
      await open(tester, daemon.store(), recheckEvery: every);
      final binding = tester.binding;
      addTearDown(
        () => binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed),
      );
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await wait(tester, every * 3);
      expect(daemon.reads, 1, reason: 'a hidden window asks nothing');
      daemon.settings!['agentsStartAgents'] = false;
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await wait(tester);
      expect(daemon.reads, 2, reason: 'once, as it comes back');
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isFalse);
      // Beside the terminal, not in front: still read on the timer.
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      daemon.settings!['agentsStartAgents'] = true;
      await wait(tester, every);
      expect(daemon.reads, 3);
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isTrue);
    });

    testWidgets('never fights a toggle', (tester) async {
      final daemon = _Daemon();
      await open(tester, daemon.store(), recheckEvery: every);
      // Saving: no read starts, however long the daemon takes.
      daemon.writeGate = Completer<void>();
      await tester.tap(
        find.byKey(const ValueKey('agent-setting-switch-agentsStartAgents')),
      );
      await wait(tester, every * 3);
      expect(daemon.reads, 1);
      expect(daemon.writes, [('agentsStartAgents', false)]);
      expect(find.text('Saving…'), findsOneWidget);
      daemon.writeGate!.complete();
      daemon.writeGate = null;
      await wait(tester);
      expect(find.text('Saving…'), findsNothing);
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isFalse);

      // A read under way when the person flips a switch: its older answer is dropped.
      daemon.readGate = Completer<void>();
      final before = daemon.reads;
      await wait(tester, every);
      expect(daemon.reads, before + 1);
      await tester.tap(
        find.byKey(const ValueKey('agent-setting-switch-pullRequestLine')),
      );
      await wait(tester);
      expect(daemon.writes.last, ('pullRequestLine', false));
      expect(switchFor(tester, AgentSetting.pullRequestLine).value, isFalse);
      daemon.readGate!.complete();
      daemon.readGate = null;
      await wait(tester);
      expect(
        switchFor(tester, AgentSetting.pullRequestLine).value,
        isFalse,
        reason:
            'the read began before the change and says pullRequestLine is on',
      );
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isFalse);
      // And the next read sees the change.
      await wait(tester, every);
      expect(switchFor(tester, AgentSetting.pullRequestLine).value, isFalse);
    });

    testWidgets('a read that fails leaves the page as it was', (tester) async {
      final daemon = _Daemon();
      await open(tester, daemon.store(), recheckEvery: every);
      daemon.readError = StateError('daemon restarting');
      await wait(tester, every);
      expect(daemon.reads, 2);
      expect(find.byKey(const Key('agent-settings-reason')), findsNothing);
      expect(switchFor(tester, AgentSetting.agentsStartAgents).value, isTrue);
      expect(
        switchFor(tester, AgentSetting.agentsStartAgents).onChanged,
        isNotNull,
      );
    });

    testWidgets('opened while the daemon was down, the next answer puts the '
        'page right', (tester) async {
      final daemon = _Daemon()..readError = StateError('no daemon');
      await open(tester, daemon.store(), recheckEvery: every);
      expect(find.byKey(const Key('agent-settings-reason')), findsOneWidget);
      expect(
        find.text('Mark pull requests from agent-started harnesses'),
        findsNothing,
      );
      daemon.readError = null;
      await wait(tester, every);
      expect(find.byKey(const Key('agent-settings-reason')), findsNothing);
      expect(
        switchFor(tester, AgentSetting.agentsStartAgents).onChanged,
        isNotNull,
      );
      expect(
        find.text('Mark pull requests from agent-started harnesses'),
        findsOneWidget,
      );
    });

    testWidgets('a page that is closed reads no more', (tester) async {
      final daemon = _Daemon();
      await open(tester, daemon.store(), recheckEvery: every);
      await tester.pumpWidget(const SizedBox());
      await wait(tester, every * 3);
      expect(daemon.reads, 1);
    });
  });

  testWidgets('in a browser: disabled, saying where it is changed', (
    tester,
  ) async {
    await open(
      tester,
      AgentSettingsStore(unavailable: 'Change this in the Harness app.'),
    );
    expect(find.text('Change this in the Harness app.'), findsOneWidget);
    expect(switchFor(tester, AgentSetting.agentsStartAgents).onChanged, isNull);
    expect(find.text('Refresh setting'), findsNothing);
  });

  group('the client', () {
    late HttpServer server;
    late ApiClient api;
    final requests = <(String, String, String?, String)>[];
    var answer = <String, dynamic>{'agentsStartAgents': true};
    var status = 200;

    setUp(() async {
      requests.clear();
      answer = {'agentsStartAgents': true};
      status = 200;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        final body = await utf8.decoder.bind(request).join();
        requests.add((
          request.method,
          request.uri.path,
          request.headers.value('x-adapter-local'),
          body,
        ));
        request.response
          ..statusCode = status
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(answer));
        await request.response.close();
      });
      api = ApiClient(
        config: AppConfig(
          localCliBaseUrl: 'http://127.0.0.1:${server.port}',
          apiBaseUrl: 'http://unused.invalid',
        ),
        session: AuthSession(storage: MemoryStore()),
      );
    });
    tearDown(() => server.close(force: true));

    test('reads the bare settings the daemon answers', () async {
      expect(await api.agentSettings(), {'agentsStartAgents': true});
      expect(requests.single.$1, 'GET');
      expect(requests.single.$2, '/api/agent-settings');
    });

    test('writes one key with the local header', () async {
      answer = {'agentsStartAgents': false, 'pullRequestLine': true};
      expect(await api.setAgentSetting('agentsStartAgents', false), {
        'agentsStartAgents': false,
        'pullRequestLine': true,
      });
      final (method, path, local, body) = requests.single;
      expect([method, path, local], ['PATCH', '/api/agent-settings', '1']);
      expect(jsonDecode(body), {'agentsStartAgents': false});
    });

    test(
      'a daemon without the route reads as none; a refusal throws its message',
      () async {
        status = 404;
        answer = {'error': 'NOT_FOUND'};
        expect(await api.agentSettings(), isNull);
        status = 400;
        answer = {
          'error': {'code': 'BAD_REQUEST', 'message': 'Nothing to change.'},
        };
        await expectLater(
          api.setAgentSetting('agentsStartAgents', true),
          throwsA(
            isA<ApiException>().having(
              (e) => e.message,
              'message',
              'Nothing to change.',
            ),
          ),
        );
      },
    );
  });
}
