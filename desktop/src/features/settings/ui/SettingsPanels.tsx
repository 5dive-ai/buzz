import {
  Archive,
  BellRing,
  Bot,
  Cpu,
  Download,
  FlaskConical,
  Keyboard,
  LayoutTemplate,
  MessagesSquare,
  MonitorCog,
  Server,
  ShieldAlert,
  Smartphone,
  Smile,
  Ticket,
  UserRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import type {
  DesktopNotificationPermissionState,
  NotificationSettings,
} from "@/features/notifications/hooks";
import type { SoundName, SoundSlot } from "@/features/notifications/lib/sound";
import { CommunityMembersSettingsCard } from "@/features/community-members/ui/CommunityMembersSettingsCard";
import { CustomEmojiSettingsCard } from "@/features/custom-emoji/ui/CustomEmojiSettingsCard";
import { LocalArchiveSettingsCard } from "@/features/local-archive/ui/LocalArchiveSettingsCard";
import { ChannelTemplatesSettingsCard } from "./ChannelTemplatesSettingsCard";
import { HarnessesSettingsPanel } from "./HarnessesSettingsPanel";
import { ExperimentalFeaturesCard } from "./ExperimentalFeaturesCard";
import { KeyboardShortcutsCard } from "./KeyboardShortcutsCard";
import { MeshComputeSettingsCard } from "@/features/mesh-compute/ui/MeshComputeSettingsCard";
import { MobilePairingCard } from "./MobilePairingCard";
import { ModerationQueueCard } from "./ModerationQueueCard";
import { NotificationSettingsCard } from "./NotificationSettingsCard";
import { PreventSleepSettingsCard } from "./PreventSleepSettingsCard";
import { AgentDefaultsSettingsCard } from "./AgentDefaultsSettingsCard";
import { HostedCommunitiesSettingsCard } from "./HostedCommunitiesSettingsCard";
import { ProfileSettingsCard } from "./ProfileSettingsCard";
import { UpdateChecker } from "../UpdateChecker";
import { ThemeSettingsCard } from "./ThemeSettingsCard";
import { VoiceSettingsCard } from "./VoiceSettingsCard";
import { AdminConsoleSettingsCard } from "@/features/admin-console/AdminConsoleSettingsCard";

export type SettingsSection =
  | "profile"
  | "notifications"
  | "voice"
  | "experimental"
  | "agents"
  | "channel-templates"
  | "compute"
  | "appearance"
  | "shortcuts"
  | "hosted-communities"
  | "community-members"
  | "moderation"
  | "custom-emoji"
  | "local-archive"
  | "mobile"
  | "updates"
  | "admin-console";

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "profile";

const SETTINGS_SECTION_VALUES: readonly SettingsSection[] = [
  "profile",
  "notifications",
  "voice",
  "experimental",
  "agents",
  "channel-templates",
  "compute",
  "appearance",
  "shortcuts",
  "hosted-communities",
  "community-members",
  "moderation",
  "custom-emoji",
  "local-archive",
  "mobile",
  "updates",
  "admin-console",
];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    typeof value === "string" &&
    (SETTINGS_SECTION_VALUES as readonly string[]).includes(value)
  );
}

export type SettingsSectionDescriptor = {
  value: SettingsSection;
  label: string;
  icon: LucideIcon;
  /** If set, this section is only visible when the feature is enabled */
  featureGate?: string;
};

export type SettingsPanelProps = {
  currentPubkey?: string;
  fallbackDisplayName?: string;
  isUpdatingDesktopNotifications: boolean;
  notificationErrorMessage: string | null;
  notificationPermission: DesktopNotificationPermissionState;
  notificationSettings: NotificationSettings;
  onSetDesktopNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
  onSetHomeBadgeEnabled: (enabled: boolean) => void;
  onSetSlotAlertsEnabled: (slot: SoundSlot, enabled: boolean) => void;
  onSetNotifyWhileViewing: (enabled: boolean) => void;
  onSetAllSlotAlertsEnabled: (enabled: boolean) => void;
  onSetSoundForSlot: (slot: SoundSlot, name: SoundName) => void;
};

export const settingsSections: SettingsSectionDescriptor[] = [
  {
    value: "appearance",
    label: "Appearance",
    icon: MonitorCog,
  },
  {
    value: "profile",
    label: "Profile",
    icon: UserRound,
  },
  {
    value: "notifications",
    label: "Notifications",
    icon: BellRing,
  },
  {
    value: "voice",
    label: "Voice",
    icon: Volume2,
  },
  {
    value: "experimental",
    label: "Experiments",
    icon: FlaskConical,
  },
  {
    value: "agents",
    label: "Agents",
    icon: Bot,
    featureGate: "managed-agents",
  },
  {
    value: "channel-templates",
    label: "Channel templates",
    icon: LayoutTemplate,
    featureGate: "channel-templates",
  },
  {
    value: "compute",
    label: "Compute",
    icon: Cpu,
  },
  {
    value: "shortcuts",
    label: "Shortcuts",
    icon: Keyboard,
  },
  {
    value: "hosted-communities",
    label: "Hosted communities",
    icon: MessagesSquare,
  },
  {
    value: "community-members",
    label: "Invites",
    icon: Ticket,
  },
  {
    value: "moderation",
    label: "Moderation",
    icon: ShieldAlert,
  },
  {
    value: "custom-emoji",
    label: "Custom emoji",
    icon: Smile,
    featureGate: "custom-emoji",
  },
  {
    value: "local-archive",
    label: "Local archive",
    icon: Archive,
  },
  {
    value: "mobile",
    label: "Mobile",
    icon: Smartphone,
  },
  {
    value: "updates",
    label: "Updates",
    icon: Download,
  },
  {
    value: "admin-console",
    label: "Admin console",
    icon: Server,
  },
];

export function renderSettingsSection(
  section: SettingsSection,
  props: SettingsPanelProps,
): React.ReactNode {
  switch (section) {
    case "profile":
      return (
        <ProfileSettingsCard
          currentPubkey={props.currentPubkey}
          fallbackDisplayName={props.fallbackDisplayName}
        />
      );
    case "notifications":
      return (
        <NotificationSettingsCard
          isUpdatingDesktopNotifications={props.isUpdatingDesktopNotifications}
          notificationErrorMessage={props.notificationErrorMessage}
          notificationPermission={props.notificationPermission}
          notificationSettings={props.notificationSettings}
          onSetDesktopNotificationsEnabled={
            props.onSetDesktopNotificationsEnabled
          }
          onSetHomeBadgeEnabled={props.onSetHomeBadgeEnabled}
          onSetSlotAlertsEnabled={props.onSetSlotAlertsEnabled}
          onSetNotifyWhileViewing={props.onSetNotifyWhileViewing}
          onSetAllSlotAlertsEnabled={props.onSetAllSlotAlertsEnabled}
          onSetSoundForSlot={props.onSetSoundForSlot}
        />
      );
    case "voice":
      return <VoiceSettingsCard />;
    case "experimental":
      return <ExperimentalFeaturesCard />;
    case "agents":
      return (
        <div className="space-y-12">
          <PreventSleepSettingsCard />
          <HarnessesSettingsPanel />
          <AgentDefaultsSettingsCard />
        </div>
      );
    case "channel-templates":
      return <ChannelTemplatesSettingsCard />;
    case "compute":
      return <MeshComputeSettingsCard />;
    case "appearance":
      return <ThemeSettingsCard />;
    case "shortcuts":
      return <KeyboardShortcutsCard />;
    case "hosted-communities":
      return <HostedCommunitiesSettingsCard />;
    case "community-members":
      return (
        <CommunityMembersSettingsCard currentPubkey={props.currentPubkey} />
      );
    case "moderation":
      return <ModerationQueueCard />;
    case "custom-emoji":
      return <CustomEmojiSettingsCard />;
    case "local-archive":
      return <LocalArchiveSettingsCard />;
    case "mobile":
      return <MobilePairingCard currentPubkey={props.currentPubkey} />;
    case "updates":
      return <UpdateChecker />;
    case "admin-console":
      return <AdminConsoleSettingsCard />;
    default: {
      const exhaustiveCheck: never = section;
      return exhaustiveCheck;
    }
  }
}
