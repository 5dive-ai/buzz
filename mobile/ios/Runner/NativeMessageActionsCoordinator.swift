import Flutter
import UIKit

struct NativeMessageActionDefinition: Equatable {
  enum Group: String, CaseIterable {
    case promoted
    case triage
    case export
    case manage
  }

  let id: String
  let title: String
  let symbol: String
  let group: Group
  let isDestructive: Bool

  init?(arguments: [String: Any]) {
    guard
      let id = arguments["id"] as? String,
      let title = arguments["title"] as? String,
      let symbol = arguments["symbol"] as? String,
      let groupName = arguments["group"] as? String,
      let group = Group(rawValue: groupName)
    else {
      return nil
    }
    self.id = id
    self.title = title
    self.symbol = symbol
    self.group = group
    isDestructive = arguments["destructive"] as? Bool ?? false
  }
}

enum NativeMessageActionSurfaceLayout {
  static let surfaceWidth: CGFloat = 288
  static let promotedHeight: CGFloat = 72
  static let rowHeight: CGFloat = 50
  static let separatorHeight: CGFloat = 0.5
  static let verticalInset: CGFloat = 4
  static let rowHorizontalInset: CGFloat = 18
  static let separatorHorizontalInset: CGFloat = rowHorizontalInset
  static let promotedHorizontalInset: CGFloat = separatorHorizontalInset
  static let rowIconColumnWidth: CGFloat = 24
  static let rowIconToTextSpacing: CGFloat = 14
  static let rowVerticalInset: CGFloat = 8

  static func populatedGroups(
    actions: [NativeMessageActionDefinition]
  ) -> [NativeMessageActionDefinition.Group] {
    NativeMessageActionDefinition.Group.allCases.filter { group in
      actions.contains { $0.group == group }
    }
  }

  static func separatorCount(
    actions: [NativeMessageActionDefinition]
  ) -> Int {
    max(0, populatedGroups(actions: actions).count - 1)
  }

  static func preferredHeight(
    actions: [NativeMessageActionDefinition]
  ) -> CGFloat {
    let promoted = actions.contains { $0.group == .promoted }
    let rowCount = actions.filter { $0.group != .promoted }.count
    return (verticalInset * 2)
      + (promoted ? promotedHeight : 0)
      + (CGFloat(rowCount) * rowHeight)
      + (CGFloat(separatorCount(actions: actions)) * separatorHeight)
  }
}

@available(iOS 16.0, *)
final class NativeMessageActionSeparatorView: UIView {
  let lineView = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)

    heightAnchor.constraint(
      equalToConstant: NativeMessageActionSurfaceLayout.separatorHeight
    ).isActive = true
    lineView.backgroundColor = .separator
    lineView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(lineView)
    NSLayoutConstraint.activate([
      lineView.leadingAnchor.constraint(
        equalTo: leadingAnchor,
        constant: NativeMessageActionSurfaceLayout.separatorHorizontalInset
      ),
      lineView.trailingAnchor.constraint(
        equalTo: trailingAnchor,
        constant: -NativeMessageActionSurfaceLayout.separatorHorizontalInset
      ),
      lineView.topAnchor.constraint(equalTo: topAnchor),
      lineView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }
}

@available(iOS 16.0, *)
final class NativeMessageActionRowControl: UIControl {
  let actionImageView: UIImageView
  let actionTitleLabel: UILabel

  init(
    definition: NativeMessageActionDefinition,
    onSelected: @escaping () -> Void
  ) {
    actionImageView = UIImageView(image: UIImage(systemName: definition.symbol))
    actionTitleLabel = UILabel()
    super.init(frame: .zero)

    let foregroundColor: UIColor = definition.isDestructive ? .systemRed : .label
    actionImageView.tintColor = foregroundColor
    actionImageView.contentMode = .center
    actionImageView.preferredSymbolConfiguration =
      NativeMessageActionSurfaceStyle.defaultSymbolConfiguration

    actionTitleLabel.text = definition.title
    actionTitleLabel.textColor = foregroundColor
    actionTitleLabel.font = NativeMessageActionSurfaceStyle.rowFont
    actionTitleLabel.adjustsFontForContentSizeCategory = true
    actionTitleLabel.numberOfLines = 0

    let iconColumn = UIView()
    iconColumn.translatesAutoresizingMaskIntoConstraints = false
    actionImageView.translatesAutoresizingMaskIntoConstraints = false
    iconColumn.addSubview(actionImageView)
    NSLayoutConstraint.activate([
      iconColumn.widthAnchor.constraint(
        equalToConstant: NativeMessageActionSurfaceLayout.rowIconColumnWidth
      ),
      iconColumn.heightAnchor.constraint(
        equalToConstant: NativeMessageActionSurfaceLayout.rowIconColumnWidth
      ),
      actionImageView.leadingAnchor.constraint(equalTo: iconColumn.leadingAnchor),
      actionImageView.trailingAnchor.constraint(equalTo: iconColumn.trailingAnchor),
      actionImageView.topAnchor.constraint(equalTo: iconColumn.topAnchor),
      actionImageView.bottomAnchor.constraint(equalTo: iconColumn.bottomAnchor),
    ])

    actionTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    addSubview(iconColumn)
    addSubview(actionTitleLabel)
    NSLayoutConstraint.activate([
      iconColumn.leadingAnchor.constraint(
        equalTo: leadingAnchor,
        constant: NativeMessageActionSurfaceLayout.rowHorizontalInset
      ),
      iconColumn.centerYAnchor.constraint(equalTo: centerYAnchor),
      actionTitleLabel.leadingAnchor.constraint(
        equalTo: iconColumn.trailingAnchor,
        constant: NativeMessageActionSurfaceLayout.rowIconToTextSpacing
      ),
      actionTitleLabel.trailingAnchor.constraint(
        equalTo: trailingAnchor,
        constant: -NativeMessageActionSurfaceLayout.rowHorizontalInset
      ),
      actionTitleLabel.topAnchor.constraint(
        equalTo: topAnchor,
        constant: NativeMessageActionSurfaceLayout.rowVerticalInset
      ),
      actionTitleLabel.bottomAnchor.constraint(
        equalTo: bottomAnchor,
        constant: -NativeMessageActionSurfaceLayout.rowVerticalInset
      ),
      heightAnchor.constraint(
        greaterThanOrEqualToConstant: NativeMessageActionSurfaceLayout.rowHeight
      ),
    ])

    accessibilityLabel = definition.title
    accessibilityTraits = .button
    isAccessibilityElement = true
    addAction(UIAction { _ in onSelected() }, for: .touchUpInside)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }

  override var isHighlighted: Bool {
    didSet {
      backgroundColor =
        isHighlighted
        ? UIColor.label.withAlphaComponent(0.08)
        : .clear
    }
  }
}

enum NativeMessageActionSurfaceStyle {
  static let promotedTextStyle = UIFont.TextStyle.footnote
  static let rowTextStyle = UIFont.TextStyle.body

  static var promotedFont: UIFont {
    UIFont.preferredFont(forTextStyle: promotedTextStyle)
  }

  static var rowFont: UIFont {
    UIFont.preferredFont(forTextStyle: rowTextStyle)
  }

  static var defaultSymbolConfiguration: UIImage.SymbolConfiguration? {
    nil
  }
}

@available(iOS 16.0, *)
final class NativeMessageActionPromotedRow: UIView {
  let buttons: [UIButton]

  init(
    actions: [NativeMessageActionDefinition],
    onSelected: @escaping (NativeMessageActionDefinition) -> Void
  ) {
    buttons = actions.map { definition in
      var configuration = UIButton.Configuration.plain()
      configuration.image = UIImage(systemName: definition.symbol)
      configuration.imagePlacement = .top
      configuration.imagePadding = 5
      configuration.baseForegroundColor = .label
      configuration.contentInsets = NSDirectionalEdgeInsets(
        top: NativeMessageActionSurfaceLayout.rowVerticalInset,
        leading: 4,
        bottom: NativeMessageActionSurfaceLayout.rowVerticalInset,
        trailing: 4
      )
      configuration.title = definition.title
      configuration.preferredSymbolConfigurationForImage =
        NativeMessageActionSurfaceStyle.defaultSymbolConfiguration
      configuration.titleTextAttributesTransformer =
        UIConfigurationTextAttributesTransformer { incoming in
          var outgoing = incoming
          outgoing.font = NativeMessageActionSurfaceStyle.promotedFont
          return outgoing
        }

      let button = UIButton(configuration: configuration)
      button.titleLabel?.adjustsFontForContentSizeCategory = true
      button.accessibilityLabel = definition.title
      button.addAction(
        UIAction { _ in onSelected(definition) },
        for: .touchUpInside
      )
      return button
    }
    super.init(frame: .zero)

    let stack = UIStackView(arrangedSubviews: buttons)
    stack.axis = .horizontal
    stack.distribution = .fillEqually
    stack.alignment = .fill
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(
        equalTo: leadingAnchor,
        constant: NativeMessageActionSurfaceLayout.promotedHorizontalInset
      ),
      stack.trailingAnchor.constraint(
        equalTo: trailingAnchor,
        constant: -NativeMessageActionSurfaceLayout.promotedHorizontalInset
      ),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      heightAnchor.constraint(
        greaterThanOrEqualToConstant: NativeMessageActionSurfaceLayout.promotedHeight
      ),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }
}

@available(iOS 16.0, *)
final class NativeMessageActionSurfaceFactory: NSObject,
  FlutterPlatformViewFactory
{
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }

  func create(
    withFrame frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?
  ) -> FlutterPlatformView {
    NativeMessageActionSurfacePlatformView(
      frame: frame,
      viewIdentifier: viewId,
      messenger: messenger,
      arguments: args
    )
  }
}

@available(iOS 16.0, *)
final class NativeMessageActionSurfacePlatformView: NSObject,
  FlutterPlatformView
{
  private let surfaceView: UIVisualEffectView
  private let channel: FlutterMethodChannel

  init(
    frame: CGRect,
    viewIdentifier viewId: Int64,
    messenger: FlutterBinaryMessenger,
    arguments args: Any?
  ) {
    surfaceView = UIVisualEffectView(
      effect: UIBlurEffect(style: .systemMaterial)
    )
    channel = FlutterMethodChannel(
      name: "buzz/native_message_action_surface/\(viewId)",
      binaryMessenger: messenger
    )
    super.init()

    surfaceView.frame = frame
    surfaceView.clipsToBounds = true
    surfaceView.layer.cornerRadius = 26
    surfaceView.layer.cornerCurve = .continuous
    surfaceView.layer.borderWidth = 0.5
    surfaceView.layer.borderColor = UIColor.separator.withAlphaComponent(0.45).cgColor
    surfaceView.accessibilityViewIsModal = true

    let actionArguments = (args as? [String: Any])?["actions"] as? [[String: Any]]
    let actions =
      actionArguments?.compactMap(
        NativeMessageActionDefinition.init(arguments:)
      ) ?? []
    install(actions: actions)
  }

  func view() -> UIView {
    surfaceView
  }

  private func install(actions: [NativeMessageActionDefinition]) {
    let scrollView = UIScrollView()
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    scrollView.alwaysBounceVertical = false
    scrollView.showsVerticalScrollIndicator = false
    scrollView.contentInsetAdjustmentBehavior = .never

    let stack = UIStackView()
    stack.axis = .vertical
    stack.spacing = 0
    stack.translatesAutoresizingMaskIntoConstraints = false

    surfaceView.contentView.addSubview(scrollView)
    scrollView.addSubview(stack)
    NSLayoutConstraint.activate([
      scrollView.leadingAnchor.constraint(equalTo: surfaceView.contentView.leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: surfaceView.contentView.trailingAnchor),
      scrollView.topAnchor.constraint(equalTo: surfaceView.contentView.topAnchor),
      scrollView.bottomAnchor.constraint(equalTo: surfaceView.contentView.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
      stack.topAnchor.constraint(
        equalTo: scrollView.contentLayoutGuide.topAnchor,
        constant: NativeMessageActionSurfaceLayout.verticalInset
      ),
      stack.bottomAnchor.constraint(
        equalTo: scrollView.contentLayoutGuide.bottomAnchor,
        constant: -NativeMessageActionSurfaceLayout.verticalInset
      ),
      stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
    ])

    var installedGroup = false
    for group in NativeMessageActionDefinition.Group.allCases {
      let groupActions = actions.filter { $0.group == group }
      guard !groupActions.isEmpty else { continue }
      if installedGroup {
        stack.addArrangedSubview(makeSeparator())
      }
      if group == .promoted {
        stack.addArrangedSubview(makePromotedRow(actions: groupActions))
      } else {
        for definition in groupActions {
          stack.addArrangedSubview(makeActionRow(definition: definition))
        }
      }
      installedGroup = true
    }
  }

  private func makePromotedRow(
    actions: [NativeMessageActionDefinition]
  ) -> UIView {
    NativeMessageActionPromotedRow(actions: actions) { [weak self] definition in
      self?.select(definition)
    }
  }

  private func makeActionRow(
    definition: NativeMessageActionDefinition
  ) -> UIView {
    NativeMessageActionRowControl(definition: definition) { [weak self] in
      self?.select(definition)
    }
  }

  private func makeSeparator() -> UIView {
    NativeMessageActionSeparatorView()
  }

  private func select(_ definition: NativeMessageActionDefinition) {
    channel.invokeMethod("selected", arguments: ["id": definition.id])
  }
}
