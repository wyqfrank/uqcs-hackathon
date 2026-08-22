import { BattleEntry } from "@/components/BattleEntry";

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { roomId } = await params;
  const { mode } = await searchParams;
  return <BattleEntry roomId={roomId.toUpperCase()} role={mode === "create" ? "host" : "guest"} />;
}
