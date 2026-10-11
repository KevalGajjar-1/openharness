import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../agent_messages/agent_messages.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';
import 'desktop_chrome.dart';

/// The Flutter counterpart of the AppKit tab: a centered name/status group
/// and, at its trailing edge, Agent Messages' ⇄ and the close action.
///
/// One revealed state: hovering the tab, or holding Command (every tab).
/// Revealed, the shortcut replaces the status and ⇄ and × both show; at rest
/// only a tab whose agents are messaging keeps its ⇄, bright.
class DesktopWorkspaceTab extends StatefulWidget {
  const DesktopWorkspaceTab({
    super.key,
    required this.id,
    required this.label,
    required this.selected,
    required this.showShortcuts,
    required this.onSelect,
    required this.onClose,
    this.shortcutHint,
    this.tooltip,
    this.activity,
    this.activityLabel,
    this.highlighted = false,
    this.onRename,
    this.agentMessages,
    this.onToggleAgentMessages,
  });

  final String id, label;
  final bool selected, highlighted;
  final ValueListenable<bool> showShortcuts;
  final VoidCallback? onSelect, onClose;
  final VoidCallback? onRename;

  /// This tab's Agent Messages, or null where a tab has none (the Store).
  final TabMessagesState? agentMessages;
  final VoidCallback? onToggleAgentMessages;
  final String? shortcutHint, tooltip, activityLabel;
  final Widget? activity;

  static double _measure(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  // × and, left of it, ⇄, inside the tab's curved body, with a dead gap
  // between them so a click just off × never toggles ⇄. Their width is
  // reserved on both sides, keeping the name centered and clear of them;
  // narrow enough that a 128pt tab still shows its name beside a status.
  static const closeWidth = 16.0, messagesWidth = 16.0, accessoryGap = 3.0;
  static const _contentInset =
      closeWidth + accessoryGap + messagesWidth + grid.AppDesktop.tabCloseInset;
  static const _indicatorGap = 6.0;

  /// What the ⇄ says it does, in each state.
  static String agentMessagesTooltip(TabMessagesState state) => switch (state) {
    TabMessagesState.off => 'Agent messages off · click to turn on',
    TabMessagesState.on => 'Agent messages on · click to turn off',
    TabMessagesState.flowing => 'Agents messaging · click to turn off',
  };

  static TextStyle _hintStyle({Color? color}) =>
      DesktopChrome.metadata(color: color).copyWith(
        fontFamilyFallback: [...grid.AppType.sansFallback, 'Apple Symbols'],
      );

  static double indicatorWidth(
    BuildContext context,
    String? hint, {
    required bool hasActivity,
  }) => math
      .max(
        hasActivity ? 16.0 : 0.0,
        hint == null || hint.isEmpty
            ? 0.0
            : _measure(context, hint, _hintStyle()),
      )
      .clamp(0.0, 72.0);

  static double labelWidth(BuildContext context, String label) =>
      _measure(context, label, DesktopChrome.control());

  static double naturalWidth(
    BuildContext context,
    String label, {
    String? shortcutHint,
    bool hasActivity = false,
  }) {
    final indicator = indicatorWidth(
      context,
      shortcutHint,
      hasActivity: hasActivity,
    );
    return labelWidth(context, label) +
        _contentInset * 2 +
        (indicator == 0 ? 0 : indicator + _indicatorGap);
  }

  /// Tabs share the available width, then scroll at their readable minimum.
  static double widthForStrip(double availableWidth, int tabCount) {
    if (tabCount == 0) return 0;
    return math.min(
      availableWidth,
      (availableWidth / tabCount)
          .clamp(grid.AppDesktop.tabMinWidth, grid.AppDesktop.tabMaxWidth)
          .floorToDouble(),
    );
  }

  @override
  State<DesktopWorkspaceTab> createState() => _DesktopWorkspaceTabState();
}

class _DesktopWorkspaceTabState extends State<DesktopWorkspaceTab> {
  bool _hovered = false, _focused = false;

  /// One of the tab's trailing controls: shown, it takes the pointer, focus
  /// and semantics; hidden, it keeps its place and none of them.
  Widget _accessory({
    required bool visible,
    required double width,
    required Widget child,
  }) => SizedBox(
    width: width,
    child: Center(
      child: IgnorePointer(
        ignoring: !visible,
        child: ExcludeFocus(
          excluding: !visible,
          child: ExcludeSemantics(
            excluding: !visible,
            child: Opacity(opacity: visible ? 1 : 0, child: child),
          ),
        ),
      ),
    ),
  );

  /// A quiet glyph that takes full ink on hover, focus and press.
  ButtonStyle _accessoryStyle(Color foreground, double resting) =>
      IconButton.styleFrom(
        backgroundColor: Colors.transparent,
        overlayColor: Colors.transparent,
        side: BorderSide.none,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ).copyWith(
        animationDuration: Duration.zero,
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) => foreground.withValues(
            alpha:
                states.any(
                  (state) =>
                      state == WidgetState.hovered ||
                      state == WidgetState.focused ||
                      state == WidgetState.pressed,
                )
                ? 1
                : resting,
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = widget.onSelect != null;
    final quietOpacity = MediaQuery.highContrastOf(context) ? .7 : .45;
    final focusVisible = _focused || widget.highlighted;
    // Workspace palettes can stay dark beside light app surfaces. Match the
    // native tab bar's ink to its own surface, independent of terminal colors.
    final foreground = grid.AppTheme.surfacePalette.foreground;
    final muted = foreground.withValues(alpha: .65);
    final fill = widget.selected
        ? grid.AppPalette.swarmWelcome
        : _hovered
        ? foreground.withValues(alpha: .06)
        : Colors.transparent;
    final ink = enabled
        ? widget.selected || _hovered || focusVisible
              ? foreground
              : muted
        : foreground.withValues(alpha: .38);
    final messages = widget.agentMessages;
    final messagesOn = messages != null && messages != TabMessagesState.off;
    final flowing = messages == TabMessagesState.flowing;
    Widget tab = Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.tabTopInset),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: fill,
          shape: DesktopTabBorder(
            side: focusVisible
                ? BorderSide(color: DesktopChrome.focusRing)
                : BorderSide.none,
          ),
        ),
        child: Semantics(
          container: true,
          explicitChildNodes: true,
          selected: widget.selected,
          child: LayoutBuilder(
            builder: (context, constraints) => ValueListenableBuilder(
              valueListenable: widget.showShortcuts,
              builder: (context, showHints, _) {
                // Hovering this tab, or holding Command, reveals it.
                final revealed = enabled && (_hovered || showHints);
                final showHint =
                    revealed && (widget.shortcutHint?.isNotEmpty ?? false);
                final indicator = DesktopWorkspaceTab.indicatorWidth(
                  context,
                  widget.shortcutHint,
                  hasActivity: widget.activity != null,
                );
                // The name sits where it rests, so revealing never moves it.
                // A tab with a status shows the shortcut in that slot; an idle
                // one shows it after the name, shortening only a name that
                // would otherwise run into ⇄.
                final restingSpace = widget.activity != null
                    ? indicator + DesktopWorkspaceTab._indicatorGap
                    : 0.0;
                final contentRight =
                    constraints.maxWidth - DesktopWorkspaceTab._contentInset;
                final restingWidth = math.min(
                  DesktopWorkspaceTab.labelWidth(context, widget.label),
                  math.max(
                    0.0,
                    contentRight -
                        DesktopWorkspaceTab._contentInset -
                        restingSpace,
                  ),
                );
                final groupLeft =
                    (constraints.maxWidth - restingWidth - restingSpace) / 2;
                var labelWidth = restingWidth;
                if (showHint && widget.activity == null) {
                  final overflow =
                      groupLeft +
                      restingWidth +
                      DesktopWorkspaceTab._indicatorGap +
                      indicator -
                      contentRight;
                  if (overflow > 0) {
                    labelWidth = math.max(0.0, restingWidth - overflow);
                  }
                }
                return Stack(
                  children: [
                    Positioned.fill(
                      child: Semantics(
                        button: true,
                        enabled: enabled,
                        label: [widget.label, ?widget.activityLabel].join(', '),
                        onTap: widget.onSelect,
                        customSemanticsActions: {
                          if (widget.onClose != null)
                            const CustomSemanticsAction(label: 'Close tab'):
                                widget.onClose!,
                          if (messages != null &&
                              widget.onToggleAgentMessages != null)
                            CustomSemanticsAction(
                              label: messagesOn
                                  ? 'Turn Agent Messages off'
                                  : 'Turn Agent Messages on',
                            ): widget.onToggleAgentMessages!,
                        },
                        child: FocusableActionDetector(
                          enabled: enabled,
                          onShowFocusHighlight: (value) =>
                              setState(() => _focused = value),
                          actions: {
                            ActivateIntent: CallbackAction<ActivateIntent>(
                              onInvoke: (_) {
                                widget.onSelect?.call();
                                return null;
                              },
                            ),
                          },
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTap: widget.onSelect,
                            onDoubleTap: widget.onRename,
                            child: ExcludeSemantics(
                              child: Stack(
                                children: [
                                  Positioned(
                                    left: groupLeft,
                                    width: labelWidth,
                                    top: 0,
                                    bottom: 0,
                                    child: Center(
                                      child: Text(
                                        widget.label,
                                        key: ValueKey('tab-label:${widget.id}'),
                                        textAlign: TextAlign.center,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.control(
                                          color: ink,
                                        ),
                                      ),
                                    ),
                                  ),
                                  if (widget.activity != null || showHint)
                                    Positioned(
                                      left:
                                          groupLeft +
                                          labelWidth +
                                          DesktopWorkspaceTab._indicatorGap,
                                      width: indicator,
                                      top: 0,
                                      bottom: 0,
                                      child: Center(
                                        child: showHint
                                            ? Text(
                                                widget.shortcutHint!,
                                                key: ValueKey(
                                                  'tab-shortcut:${widget.id}',
                                                ),
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style:
                                                    DesktopWorkspaceTab._hintStyle(
                                                      color: ink,
                                                    ),
                                              )
                                            : widget.activity,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: grid.AppDesktop.tabCloseInset,
                      top: 0,
                      bottom: 0,
                      child: Row(
                        children: [
                          _accessory(
                            visible:
                                messages != null &&
                                enabled &&
                                (revealed || flowing),
                            width: DesktopWorkspaceTab.messagesWidth,
                            child: messages == null
                                ? const SizedBox.shrink()
                                : _AgentMessagesButton(
                                    key: ValueKey(
                                      'tab-agent-messages:${widget.id}',
                                    ),
                                    state: messages,
                                    onPressed: widget.onToggleAgentMessages,
                                    style: _accessoryStyle(
                                      foreground,
                                      flowing ? 1 : quietOpacity,
                                    ),
                                  ),
                          ),
                          const SizedBox(
                            width: DesktopWorkspaceTab.accessoryGap,
                          ),
                          _accessory(
                            visible: revealed,
                            width: DesktopWorkspaceTab.closeWidth,
                            child: IconButton(
                              key: ValueKey('tab-close:${widget.id}'),
                              tooltip: 'Close tab',
                              onPressed: widget.onClose,
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints.tightFor(
                                width: DesktopWorkspaceTab.closeWidth,
                                height: 32,
                              ),
                              style: _accessoryStyle(foreground, quietOpacity),
                              icon: const Icon(
                                AppIcons.close,
                                size: AppIcons.closeSize,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    if (widget.tooltip case final tooltip? when tooltip.isNotEmpty) {
      tab = Tooltip(message: tooltip, excludeFromSemantics: true, child: tab);
    }
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      excludeFromSemantics: true,
      onTap: widget.onSelect,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: tab,
      ),
    );
  }
}

/// Agent Messages' ⇄: dim when off (struck through) or on and quiet, bright
/// while agents are messaging. Its tooltip says what a click does.
class _AgentMessagesButton extends StatelessWidget {
  const _AgentMessagesButton({
    super.key,
    required this.state,
    required this.onPressed,
    required this.style,
  });

  final TabMessagesState state;
  final VoidCallback? onPressed;
  final ButtonStyle style;

  @override
  Widget build(BuildContext context) {
    final tooltip = DesktopWorkspaceTab.agentMessagesTooltip(state);
    // One node that says what it is and whether it is on; the tooltip's
    // sentence is its hint, not a second label.
    return Semantics(
      container: true,
      button: true,
      toggled: state != TabMessagesState.off,
      label: 'Agent Messages',
      hint: tooltip,
      onTap: onPressed,
      excludeSemantics: true,
      child: Tooltip(
        message: tooltip,
        excludeFromSemantics: true,
        child: IconButton(
          onPressed: onPressed,
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints.tightFor(
            width: DesktopWorkspaceTab.messagesWidth,
            height: 32,
          ),
          style: style,
          icon: _MessagesGlyph(struck: state == TabMessagesState.off),
        ),
      ),
    );
  }
}

/// ⇄, struck through while Agent Messages are off.
class _MessagesGlyph extends StatelessWidget {
  const _MessagesGlyph({required this.struck});
  final bool struck;

  @override
  Widget build(BuildContext context) {
    const icon = Icon(AppIcons.arrowRightLeft, size: 13);
    if (!struck) return icon;
    return CustomPaint(
      key: const ValueKey('agent-messages-struck'),
      foregroundPainter: _SlashPainter(
        IconTheme.of(context).color ?? DesktopChrome.foreground,
      ),
      child: icon,
    );
  }
}

class _SlashPainter extends CustomPainter {
  const _SlashPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) => canvas.drawLine(
    Offset(size.width * .15, size.height * .9),
    Offset(size.width * .85, size.height * .1),
    Paint()
      ..color = color
      ..strokeWidth = 1.2
      ..strokeCap = StrokeCap.round,
  );

  @override
  bool shouldRepaint(_SlashPainter oldDelegate) => oldDelegate.color != color;
}
