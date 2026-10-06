import { Text } from "react-native";

export function Value({
  children,
  color,
  compact,
}: {
  children: string;
  color: string;
  compact: boolean;
}) {
  return (
    <Text
      selectable
      style={{ color, fontSize: compact ? 13 : 14, lineHeight: 20 }}
    >
      {children}
    </Text>
  );
}
