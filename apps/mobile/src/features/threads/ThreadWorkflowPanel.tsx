import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

const STATUS_LABEL: Record<RuntimeSubagent["status"], string> = {
  pending: "Queued",
  running: "Working",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

function statusDotClass(status: RuntimeSubagent["status"]): string {
  if (status === "failed") return "bg-danger-foreground";
  if (status === "completed") return "bg-emerald-500";
  if (status === "running" || status === "pending" || status === "waiting") {
    return "bg-sky-500";
  }
  return "bg-foreground-muted";
}

function AgentRow({ agent }: { readonly agent: RuntimeSubagent }) {
  const detail = agent.error ?? agent.progress ?? agent.result ?? STATUS_LABEL[agent.status];
  const tokens = agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null;
  return (
    <View className="flex-row items-start gap-2 py-1.5">
      <View className={cn("mt-1.5 h-1.5 w-1.5 rounded-full", statusDotClass(agent.status))} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-baseline justify-between gap-2">
          <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
            {agent.title}
          </Text>
          <Text className="text-2xs text-foreground-muted">
            {[STATUS_LABEL[agent.status], tokens].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Text className="text-2xs leading-snug text-foreground-muted" numberOfLines={2}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

function WorkflowGroup({ group }: { readonly group: AgentPanelWorkflowGroup }) {
  return (
    <View className="gap-1 border-t border-border-subtle px-3 py-2.5">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
          {group.workflow.workflowName ?? group.workflow.title}
        </Text>
        <Text className="text-2xs text-foreground-muted">
          {STATUS_LABEL[group.workflow.status]}
        </Text>
      </View>
      {group.phases.map((phase) => (
        <View key={phase.index} className="gap-0.5">
          <View className="flex-row items-center justify-between gap-2 pt-1">
            <Text className="text-2xs font-t3-bold uppercase tracking-[0.7px] text-foreground-muted">
              {phase.index + 1}. {phase.title}
            </Text>
            <Text className="text-2xs text-foreground-muted">
              {phase.settledCount}/{phase.members.length}
            </Text>
          </View>
          {phase.members.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </View>
      ))}
      {group.unphasedMembers.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
      {group.workflow.progress ? (
        <Text className="pt-0.5 text-2xs leading-snug text-foreground-muted" numberOfLines={2}>
          {group.workflow.progress}
        </Text>
      ) : null}
    </View>
  );
}

export const ThreadWorkflowPanel = memo(function ThreadWorkflowPanel(props: {
  readonly model: AgentPanelModel;
}) {
  const workflows = props.model.workflows;
  const liveCount = props.model.liveCount;
  const [expanded, setExpanded] = useState(liveCount > 0);
  const previousLiveCountRef = useRef(liveCount);
  const iconColor = useThemeColor("--color-icon-subtle");

  useEffect(() => {
    if (previousLiveCountRef.current === 0 && liveCount > 0) setExpanded(true);
    previousLiveCountRef.current = liveCount;
  }, [liveCount]);

  if (!props.model.hasAgents) return null;

  const summary = liveCount > 0 ? `${liveCount} running` : `${props.model.settledCount} settled`;

  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} agent work`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center justify-between gap-3 px-3 py-2.5 active:bg-subtle"
      >
        <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text className="text-xs font-t3-bold">Agent work</Text>
          <Text className="text-2xs text-foreground-muted">{summary}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="font-mono text-2xs text-foreground-muted">
            Σ {formatSubagentTokenCount(props.model.totalTokens)} tok
          </Text>
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.up"}
            size={12}
            tintColor={iconColor}
            type="monochrome"
          />
        </View>
      </Pressable>
      {expanded ? (
        <ScrollView className="max-h-64" nestedScrollEnabled>
          {workflows.map((group) => (
            <WorkflowGroup key={group.workflow.id} group={group} />
          ))}
          {props.model.directAgents.length > 0 ? (
            <View className="gap-0.5 border-t border-border-subtle px-3 py-2.5">
              <Text className="pb-1 text-2xs font-t3-bold uppercase tracking-[0.7px] text-foreground-muted">
                Direct agents
              </Text>
              {props.model.directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
});
