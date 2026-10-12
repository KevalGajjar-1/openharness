import 'dart:ui' show Tristate;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_workspace_tab.dart';

import 'support/agent_messages_api.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

/// The tab's Agent Messages (docs/design/2026-10-10-agent-messages.md, "The
/// tab"): hovering a tab reveals 💬 — grey while off, its color while on — and
/// ×. Traffic between its agents shows nothing on the tab.
typedef _Spec = ({String id, TabMessagesState? messages, bool working});

const _messagesColor = Color(0xffbc3fbc);

Widget _host(
  List<_Spec> tabs, {
  Brightness brightness = Brightness.dark,
  void Function(String id)? onToggle,
  void Function(String id)? onSelect,
}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: grid.buildAppTheme(brightness: brightness),
  themeAnimationDuration: Duration.zero,
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        height: 40,
        child: Row(
          children: [
            for (final (index, tab) in tabs.indexed)
              SizedBox(
                width: 240,
                child: DesktopWorkspaceTab(
                  id: tab.id,
                  label: tab.id,
                  selected: index == 0,
                  onSelect: () => onSelect?.call(tab.id),
                  onClose: () {},
                  agentMessages: tab.messages,
                  messagesColor: _messagesColor,
                  onToggleAgentMessages: () => onToggle?.call(tab.id),
                  activityLabel: tab.working ? 'Working' : null,
                  activity: tab.working
                      ? SizedBox(
                          key: ValueKey('status:${tab.id}'),
                          width: 16,
                          child: const Text('⠋'),
                        )
                      : null,
                ),
              ),
          ],
        ),
      ),
    ),
  ),
);

Finder _messages(String id) => find.byKey(ValueKey('tab-agent-messages:$id'));
Finder _close(String id) => find.byKey(ValueKey('tab-close:$id'));
Finder _label(String id) => find.byKey(ValueKey('tab-label:$id'));

Finder _glyphOf(String id) =>
    find.descendant(of: _messages(id), matching: find.byType(Icon));

/// The ink the 💬 glyph is drawn in, while the pointer is not on it.
Color _glyph(WidgetTester tester, String id) =>
    IconTheme.of(tester.element(_glyphOf(id))).color!;

/// Which 💬 is drawn: filled while on, an outline while off (owner, 2026-10-12:
/// one outline in two tints read alike).
IconData _drawn(WidgetTester tester, String id) =>
    tester.widget<Icon>(_glyphOf(id)).icon!;

String _tooltip(WidgetTester tester, String id) => tester
    .widget<Tooltip>(
      find.descendant(of: _messages(id), matching: find.byType(Tooltip)).first,
    )
    .message!;

Future<TestGesture> _hover(WidgetTester tester, String id) async {
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  await mouse.addPointer(location: tester.getCenter(_label(id)));
  addTearDown(mouse.removePointer);
  await tester.pump();
  return mouse;
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('off: nothing at rest; hovered, a grey 💬 beside × '
        '(${brightness.name})', (tester) async {
      final toggled = <String>[];
      await tester.pumpWidget(
        _host(
          [(id: 'app', messages: TabMessagesState.off, working: false)],
          brightness: brightness,
          onToggle: toggled.add,
        ),
      );
      expect(_messages('app').hitTestable(), findsNothing);
      expect(_close('app').hitTestable(), findsNothing);
      final title = tester.getRect(_label('app'));
      await _hover(tester, 'app');
      expect(_messages('app').hitTestable(), findsOneWidget);
      expect(_close('app').hitTestable(), findsOneWidget);
      final grey = _glyph(tester, 'app');
      expect(grey.a, closeTo(.35, .01));
      expect(_drawn(tester, 'app'), AppIcons.agentMessagesOff);
      expect(
        grey.withValues(alpha: 1),
        grid.AppTheme.surfacePalette.foreground,
        reason: 'off is the tab ink, quiet: grey',
      );
      expect(find.text('⌘1'), findsNothing, reason: 'tabs show no shortcut');
      expect(_tooltip(tester, 'app'), 'Agent messages off · click to turn on');
      final messages = tester.getRect(_messages('app'));
      final close = tester.getRect(_close('app'));
      expect(
        close.left - messages.right,
        DesktopWorkspaceTab.accessoryGap,
        reason: '💬 sits left of ×, past a gap that neither takes',
      );
      await tester.tapAt(Offset(close.left - 1.5, close.center.dy));
      await tester.pump();
      expect(toggled, isEmpty, reason: 'a click just off × toggles nothing');
      expect(messages.size, const Size(DesktopWorkspaceTab.messagesWidth, 32));
      expect(
        tester.getRect(_label('app')),
        title,
        reason: 'a name with room never moves',
      );
    });
  }

  testWidgets('on: hovered, 💬 in Agent Messages\' color', (tester) async {
    await tester.pumpWidget(
      _host([(id: 'app', messages: TabMessagesState.on, working: true)]),
    );
    expect(_messages('app').hitTestable(), findsNothing);
    expect(find.byKey(const ValueKey('status:app')), findsOneWidget);
    await _hover(tester, 'app');
    expect(_messages('app').hitTestable(), findsOneWidget);
    final ink = _glyph(tester, 'app');
    expect(ink.withValues(alpha: 1), _messagesColor);
    expect(ink.a, closeTo(1, .01));
    expect(_drawn(tester, 'app'), AppIcons.agentMessagesOn);
    expect(_tooltip(tester, 'app'), 'Agent messages on · click to turn off');
    expect(
      find.byKey(const ValueKey('status:app')),
      findsOneWidget,
      reason: 'hover keeps the status',
    );
  });

  testWidgets('hover reveals only its own tab', (tester) async {
    await tester.pumpWidget(
      _host([
        (id: 'one', messages: TabMessagesState.off, working: false),
        (id: 'two', messages: TabMessagesState.on, working: true),
        (id: 'store', messages: null, working: false),
      ]),
    );
    final mouse = await _hover(tester, 'one');
    expect(_close('one').hitTestable(), findsOneWidget);
    expect(_close('two').hitTestable(), findsNothing);
    expect(_messages('two').hitTestable(), findsNothing);
    await mouse.moveTo(tester.getCenter(_label('store')));
    await tester.pump();
    expect(_close('store').hitTestable(), findsOneWidget);
    expect(
      _messages('store'),
      findsNothing,
      reason: 'the Store tab has no Agent Messages',
    );
  });

  testWidgets('clicking 💬 toggles that tab without selecting it', (
    tester,
  ) async {
    final toggled = <String>[], selected = <String>[];
    await tester.pumpWidget(
      _host(
        [
          (id: 'one', messages: TabMessagesState.off, working: false),
          (id: 'two', messages: TabMessagesState.on, working: false),
        ],
        onToggle: toggled.add,
        onSelect: selected.add,
      ),
    );
    await _hover(tester, 'two');
    await tester.tap(_messages('two'));
    await tester.pump();
    expect(toggled, ['two']);
    expect(selected, isEmpty);
  });

  testWidgets('the 💬 has a label and a state', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      _host([
        (id: 'app', messages: TabMessagesState.on, working: false),
        (id: 'off', messages: TabMessagesState.off, working: false),
      ]),
    );
    // Hidden at rest: off the semantics tree until revealed, but the tab
    // itself still offers the action.
    expect(find.semantics.byLabel('Agent Messages').evaluate(), isEmpty);
    final mouse = await _hover(tester, 'app');
    final on = tester.getSemantics(_messages('app'));
    expect(on.label, 'Agent Messages');
    expect(on.hint, 'Agent messages on · click to turn off');
    expect(on.getSemanticsData().flagsCollection.isToggled, Tristate.isTrue);
    await mouse.moveTo(tester.getCenter(_label('off')));
    await tester.pump();
    final off = tester.getSemantics(_messages('off'));
    expect(off.getSemanticsData().flagsCollection.isToggled, Tristate.isFalse);
    final tab = tester.getSemantics(find.bySemanticsLabel(RegExp(r'^off$')));
    final actions = [
      for (final id in tab.getSemanticsData().customSemanticsActionIds!)
        CustomSemanticsAction.getAction(id)!.label,
    ];
    expect(actions, containsAll(['Close tab', 'Turn Agent Messages on']));
    semantics.dispose();
  });

  testWidgets(
    'the workspace strip offers 💬 only on desk tabs, once answered',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      await mount(tester, app);
      final before = app.activeSwarmId;
      expect(_messages(before), findsNothing, reason: 'before the desk');
      await tester.pumpWidget(const SizedBox());
      final api = await joinAgentMessagesDesk(app);
      await mount(tester, app);
      final tab = app.activeSwarmId;
      expect(_messages(tab), findsOneWidget);
      app.openStore();
      await tester.pump();
      expect(app.activeSwarm.isStore, isTrue);
      expect(_messages(app.activeSwarmId), findsNothing, reason: 'the Store');
      api.unsupported = true;
      await app.agentMessages.refresh();
      await tester.pump();
      expect(_messages(tab), findsNothing, reason: 'an older CLI or backend');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a message moving in a tab changes nothing on it', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final api = await joinAgentMessagesDesk(app);
    final tab = app.activeSwarmId;
    api.flags[tab] = true;
    await app.agentMessages.refresh();
    await mount(tester, app);
    List<String?> tooltips() => [
      for (final tooltip in tester.widgetList<Tooltip>(
        find.ancestor(of: _label(tab), matching: find.byType(Tooltip)),
      ))
        tooltip.message,
    ];
    final label = tester.getRect(_label(tab));
    final hints = tooltips();
    app.agentMessages.handleEvent({
      'tabId': tab,
      'messageId': 'm0000001',
      'at': 1,
      'from': {'machineId': 'studio', 'agentId': 'lead'},
      'to': [
        {'machineId': 'laptop', 'agentId': 'api', 'state': 'queued'},
      ],
    });
    await tester.pump();
    expect(app.agentMessages.trafficFor(tab), 1);
    expect(app.agentMessages.stateOf(tab), TabMessagesState.on);
    expect(
      tester.getRect(_label(tab)),
      label,
      reason: 'no status slot opens beside the name',
    );
    expect(tooltips(), hints);
    expect(_messages(tab).hitTestable(), findsNothing, reason: 'no 💬 at rest');
    expect(find.byIcon(AppIcons.agentMessagesOn).hitTestable(), findsNothing);
    // Let the pane marks lapse before the test ends.
    await tester.pump(app.agentMessages.markLife);
    await tester.pumpWidget(const SizedBox());
  });
}
