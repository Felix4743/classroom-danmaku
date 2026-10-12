/**
 * 托盘图标：16×16 的 PNG，直接内联成 base64。
 *
 * 为什么不放一个 `assets/tray.png` 文件：打包之后资源目录的位置变了
 * （`extraResources` 里塞的是 `src/`），图标走文件路径就得在
 * 开发期/打包后两套路径里二选一，一旦写错，托盘图标变成一个看不见的
 * 空位 —— 而托盘是老师**唯一**能退出弹幕层的地方（全屏、鼠标穿透、
 * 没有标题栏），图标看不见就等于退不出去，只能开任务管理器。
 * 内联之后没有路径，也就没有这个失败模式。
 *
 * 图案：B 站粉的圆角方块 + 三条白杠。
 */

/** 16×16 RGBA PNG 的 base64（不含 `data:` 前缀）。 */
export const TRAY_ICON_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR42mNgQAL/02b+JwYzoANiNeI0iCIDyNUMN4T6BhACtHfBqBcGwAsDnxcozc4ATbjZQ1JI83gAAAAASUVORK5CYII=";

/** 给 `nativeImage.createFromDataURL` 用的完整 data URL。 */
export const TRAY_ICON_DATA_URL = `data:image/png;base64,${TRAY_ICON_PNG}`;
