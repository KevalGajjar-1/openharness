// The cloud agents' design image (docs/design/images/cloud-chat-pane.png): a
// Fo harness's chat pane beside a terminal pane, so its header can be held to
// every pane's. Rendered only when HARNESS_CLOUD_CAPTURE_DIR names a folder;
// otherwise it checks the same scene renders.

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/cloud_chat_pane.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'cloud_agents_test.dart'
    show CloudConnection, CreateConnection, cloudFrame;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'support/real_fonts.dart';

void main() {
  final capture = Platform.environment['HARNESS_CLOUD_CAPTURE_DIR'];

  setUpAll(() async {
    if (capture != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('SF Mono', '/System/Library/Fonts/SFNSMono.ttf'),
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('Roboto', '/System/Library/Fonts/Supplemental/Arial.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  testWidgets(
    'a Fo harness beside a terminal: the same header, a conversation in place of a terminal',
    (tester) async {
      final connection = CloudConnection();
      final app = createApp(
        connectionForTest: (_) => connection,
        connected: true,
      );
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', <TerminalBinaryFrame>[]));
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {'agent': cloudFrame()},
      });
      await app.handleEventForTest('m', {
        'type': 'commander_question',
        'agentId': 'cloud_1',
        'payload': {
          'requestId': 'cloud_q_1',
          'questions': [
            {
              'key': 'answer',
              'q': 'Which one?',
              'options': ['9:30', '11:00', 'neither'],
              'multi': false,
              'canText': true,
            },
          ],
        },
      });
      await app.addAgentToSwarm('m', 'cloud_1');
      await mount(tester, app);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(CloudChatPane), findsOneWidget);
      if (capture == null) return;
      await tester.runAsync(() async {
        final view = tester.binding.renderViews.first;
        final image = await (view.debugLayer! as OffsetLayer).toImage(
          Offset.zero & view.size,
          pixelRatio: 2,
        );
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$capture/cloud-chat-pane.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    },
  );

  testWidgets(
    'New Harness with Devin Cloud: its cloud for a computer, a GitHub repository, an ACU limit',
    (tester) async {
      final app = createApp(
        connectionForTest: (_) => CreateConnection(),
        connected: true,
      );
      addTearDown(app.dispose);
      // A folder this computer already works in, whose remote is on GitHub.
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'a-api',
            'name': 'api',
            'engine': 'claude',
            'terminal': {
              'available': true,
              'runtimes': [
                {'backend': 'tmux', 'paneId': '%1'},
              ],
            },
            'project': {
              'kind': 'git',
              'name': 'api',
              'cwd': '/work/api',
              'root': '/work/api',
              'remote': 'https://github.com/acme/api',
              'branch': 'main',
            },
          },
        },
      });
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'devin-cloud',
        folder: '/work/api',
        task: 'fix the flaky login test',
      );
      addTearDown(box.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(820, 360);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark(),
          debugShowCheckedModeBanner: false,
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              desktop: true,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // No caret or selection handle in the picture.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      expect(box.cloudRepository, 'https://github.com/acme/api');
      expect(find.text("Devin's cloud"), findsOneWidget);
      expect(find.text('acme/api'), findsOneWidget);
      if (capture != null)
        await tester.runAsync(() async {
          final view = tester.binding.renderViews.first;
          final image = await (view.debugLayer! as OffsetLayer).toImage(
            Offset.zero & view.size,
            pixelRatio: 2,
          );
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$capture/cloud-new-harness.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      expect(find.text('Up to 5 ACUs'), findsOneWidget);
    },
  );
}
