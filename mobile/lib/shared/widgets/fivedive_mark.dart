import 'package:flutter/material.dart';

/// The 5dive mark, painted as a solid silhouette in [color].
///
/// The asset is an alpha mask cut from the same source art the launcher icons
/// are generated from, so the home screen and the onboarding hero show one
/// mark. It is the app's one brand mark: the onboarding hero and the
/// pull-to-refresh indicator both render it.
class FiveDiveMark extends StatelessWidget {
  /// The rendered height of the mark.
  ///
  /// Width follows from the mark's 342:512 aspect ratio.
  final double height;

  /// The color used for the mark's silhouette.
  final Color color;

  const FiveDiveMark({required this.height, required this.color, super.key});

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/images/5dive-mark.png',
      height: height,
      color: color,
      semanticLabel: '5dive',
    );
  }
}
