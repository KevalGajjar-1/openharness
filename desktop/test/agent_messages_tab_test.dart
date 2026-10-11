import 'dart:ui' show Tristate;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_workspace_tab.dart';

/// The tab's ⇄ and the one revealed state (docs/design/2026-10-10-agent-messages.md,
/// "The tab"): hovering a tab or holding Command reveals the shortcut, ⇄ and ×;
/// at rest only a tab whose agents are messaging keeps a bright ⇄.
typedef _Spec = ({String id, TabMessagesState? messages, bool working});

Widget _host(
  ValueNotifier<bool> command,
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
                  shortcutHint: '⌘${index + 1}',
                  showShortcuts: command,
                  onSelect: () => onSelect?.call(tab.id),
                  onClose: () {},
                  agentMessages: tab.messages,
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
Finder _hint(String id) => find.byKey(ValueKey('tab-shortcut:$id'));
Finder _struck(String id) => find.descendant(
  of: _messages(id),
  matching: find.byKey(const ValueKey('agent-messages-struck')),
);

/// The ink the ⇄ glyph is drawn in, while the pointer is not on it.
double _glyphAlpha(WidgetTester tester, String id) => IconTheme.of(
  tester.element(
    find.descendant(
      of: _messages(id),
      matching: find.byIcon(AppIcons.arrowRightLeft),
    ),
  ),
).color!.a;

String _tooltip(WidgetTester tester, String id) => tester
    .widget<Tooltip>(
      find.descendant(of: _messages(id), matching: find.byType(Tooltip)).first,
    )
    .message!;

void main() {
  late ValueNotifier<bool> command;
  setUp(() => command = ValueNotifier(false));
  tearDown(() => command.dispose());

  for (final brightness in Brightness.values) {
    testWidgets(
      'off: nothing at rest; revealed, ⌘1 and a struck dim ⇄ beside × '
      '(${brightness.name})',
      (tester) async {
        await tester.pumpWidget(
          _host(command, [
            (id: 'app', messages: TabMessagesState.off, working: false),
          ], brightness: brightness),
        );
        expect(_messages('app').hitTestable(), findsNothing);
        expect(_close('app').hitTestable(), findsNothing);
        expect(_hint('app'), findsNothing);
        final title = tester.getRect(_label('app'));
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: title.center);
        addTearDown(mouse.removePointer);
        await tester.pump();
        expect(_hint('app'), findsOneWidget);
        expect(_messages('app').hitTestable(), findsOneWidget);
        expect(_close('app').hitTestable(), findsOneWidget);
        expect(_struck('app'), findsOneWidget);
        expect(_glyphAlpha(tester, 'app'), closeTo(.45, .01));
        expect(
          _tooltip(tester, 'app'),
          'Agent messages off · click to turn on',
        );
        final messages = tester.getRect(_messages('app'));
        final close = tester.getRect(_close('app'));
        expect(messages.right, close.left, reason: '⇄ sits just left of ×');
        expect(
          messages.size,
          const Size(DesktopWorkspaceTab.messagesWidth, 32),
        );
        expect(tester.getRect(_label('app')), title, reason: 'never moves');
        expect(
          tester.getRect(_hint('app')).right,
          lessThanOrEqualTo(messages.left),
        );
      },
    );
  }

  testWidgets('on and quiet: a dim ⇄ only when revealed', (tester) async {
    await tester.pumpWidget(
      _host(command, [
        (id: 'app', messages: TabMessagesState.on, working: true),
      ]),
    );
    expect(_messages('app').hitTestable(), findsNothing);
    expect(find.byKey(const ValueKey('status:app')), findsOneWidget);
    command.value = true;
    await tester.pump();
    expect(_messages('app').hitTestable(), findsOneWidget);
    expect(_struck('app'), findsNothing);
    expect(_glyphAlpha(tester, 'app'), closeTo(.45, .01));
    expect(_tooltip(tester, 'app'), 'Agent messages on · click to turn off');
    expect(_hint('app'), findsOneWidget);
    expect(find.byKey(const ValueKey('status:app')), findsNothing);
  });

  testWidgets('flowing: a bright ⇄ at rest, without ×', (tester) async {
    await tester.pumpWidget(
      _host(command, [
        (id: 'app', messages: TabMessagesState.flowing, working: false),
      ]),
    );
    expect(_messages('app').hitTestable(), findsOneWidget);
    expect(_close('app').hitTestable(), findsNothing);
    expect(_hint('app'), findsNothing);
    expect(_glyphAlpha(tester, 'app'), 1);
    expect(_tooltip(tester, 'app'), 'Agents messaging · click to turn off');
    command.value = true;
    await tester.pump();
    expect(_close('app').hitTestable(), findsOneWidget);
    expect(_glyphAlpha(tester, 'app'), 1);
  });

  testWidgets('Command reveals every tab; hover reveals only its own', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(command, [
        (id: 'one', messages: TabMessagesState.off, working: false),
        (id: 'two', messages: TabMessagesState.on, working: true),
        (id: 'store', messages: null, working: false),
      ]),
    );
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: tester.getCenter(_label('one')));
    addTearDown(mouse.removePointer);
    await tester.pump();
    expect(_close('one').hitTestable(), findsOneWidget);
    expect(_close('two').hitTestable(), findsNothing);
    expect(_hint('two'), findsNothing);
    await mouse.moveTo(const Offset(900, 300));
    await tester.pump();
    command.value = true;
    await tester.pump();
    for (final id in ['one', 'two', 'store']) {
      expect(_close(id).hitTestable(), findsOneWidget, reason: id);
      expect(_hint(id), findsOneWidget, reason: id);
    }
    expect(_messages('one').hitTestable(), findsOneWidget);
    expect(_messages('two').hitTestable(), findsOneWidget);
    expect(
      _messages('store'),
      findsNothing,
      reason: 'the Store tab has no Agent Messages',
    );
    command.value = false;
    await tester.pump();
    for (final id in ['one', 'two', 'store']) {
      expect(_close(id).hitTestable(), findsNothing, reason: id);
    }
  });

  testWidgets('clicking ⇄ toggles that tab without selecting it', (
    tester,
  ) async {
    final toggled = <String>[], selected = <String>[];
    await tester.pumpWidget(
      _host(
        command,
        [
          (id: 'one', messages: TabMessagesState.off, working: false),
          (id: 'two', messages: TabMessagesState.flowing, working: false),
        ],
        onToggle: toggled.add,
        onSelect: selected.add,
      ),
    );
    await tester.tap(_messages('two'));
    await tester.pump();
    expect(toggled, ['two']);
    expect(selected, isEmpty);
  });

  testWidgets('the ⇄ has a label and a state', (tester) async {
    final semantics = tester.ensureSemantics();
    final toggled = <String>[];
    await tester.pumpWidget(
      _host(command, [
        (id: 'app', messages: TabMessagesState.flowing, working: false),
        (id: 'off', messages: TabMessagesState.off, working: false),
      ], onToggle: toggled.add),
    );
    final on = tester.getSemantics(_messages('app'));
    expect(on.label, 'Agent Messages');
    expect(on.hint, 'Agents messaging · click to turn off');
    expect(on.getSemanticsData().flagsCollection.isToggled, Tristate.isTrue);
    // Hidden at rest: off the semantics tree until revealed, but the tab
    // itself still offers the action.
    expect(find.semantics.byLabel('Agent Messages').evaluate(), hasLength(1));
    command.value = true;
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
}
