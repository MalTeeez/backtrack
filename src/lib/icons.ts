/**
 * The icons of the Review workspace by name. Each is the moving icon (@jis3r/icons) where one exists, else the Lucide
 * one. Each moving icon imports on its own path, because the index of the package made svelte-check run out of memory.
 */
import type { Component } from 'svelte';
import ArrowDownUpL from '@lucide/svelte/icons/arrow-down-up';
import AppWindowL from '@lucide/svelte/icons/app-window';
import BoxL from '@lucide/svelte/icons/box';
import CircleDotL from '@lucide/svelte/icons/circle-dot';
import CrosshairL from '@lucide/svelte/icons/crosshair';
import FilmL from '@lucide/svelte/icons/film';
import FlameL from '@lucide/svelte/icons/flame';
import GanttChartL from '@lucide/svelte/icons/chart-gantt';
import LocateFixedL from '@lucide/svelte/icons/locate-fixed';
import MapL from '@lucide/svelte/icons/map';
import MapPinL from '@lucide/svelte/icons/map-pin';
import MountainL from '@lucide/svelte/icons/mountain';
import ScanL from '@lucide/svelte/icons/scan';
import ScanSearchL from '@lucide/svelte/icons/scan-search';
import TrophyL from '@lucide/svelte/icons/trophy';
import VideoL from '@lucide/svelte/icons/video';
import Check from '@jis3r/icons/icons/check';
import CheckCheck from '@jis3r/icons/icons/check-check';
import ChevronDown from '@jis3r/icons/icons/chevron-down';
import Clapperboard from '@jis3r/icons/icons/clapperboard';
import Clock from '@jis3r/icons/icons/clock';
import Compass from '@jis3r/icons/icons/compass';
import EyeOff from '@jis3r/icons/icons/eye-off';
import Gauge from '@jis3r/icons/icons/gauge';
import Layers from '@jis3r/icons/icons/layers';
import ListChecks from '@jis3r/icons/icons/list-checks';
import Maximize2 from '@jis3r/icons/icons/maximize-2';
import Minimize2 from '@jis3r/icons/icons/minimize-2';
import Minus from '@jis3r/icons/icons/minus';
import PanelTopOpen from '@jis3r/icons/icons/panel-top-open';
import RotateCcw from '@jis3r/icons/icons/rotate-ccw';
import SquareArrowDownLeft from '@jis3r/icons/icons/square-arrow-down-left';
import SquareArrowOutUpRight from '@jis3r/icons/icons/square-arrow-out-up-right';
import SquarePen from '@jis3r/icons/icons/square-pen';
import Timer from '@jis3r/icons/icons/timer';

export type Icon = Component<{ size?: number; class?: string }>;

export const ICONS = {
  appWindow: AppWindowL, arrowDownUp: ArrowDownUpL, attach: SquareArrowDownLeft, float: SquareArrowOutUpRight, box: BoxL, check: Check, checkCheck: CheckCheck, chevronDown: ChevronDown,
  circleDot: CircleDotL, clapperboard: Clapperboard, clock: Clock, compass: Compass, crosshair: CrosshairL, eyeOff: EyeOff,
  film: FilmL, flame: FlameL, gantt: GanttChartL, gauge: Gauge, layers: Layers, listChecks: ListChecks, locate: LocateFixedL,
  map: MapL, mapPin: MapPinL, maximize: Maximize2, minimize: Minimize2, minus: Minus, mountain: MountainL, restore: PanelTopOpen,
  rotateCcw: RotateCcw, scan: ScanL, scanSearch: ScanSearchL, squarePen: SquarePen, timer: Timer, trophy: TrophyL, video: VideoL,
} satisfies Record<string, Icon>;
export type IconName = keyof typeof ICONS;
