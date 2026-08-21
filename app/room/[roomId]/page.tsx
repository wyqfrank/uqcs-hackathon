import { BattleRoom } from "@/components/BattleRoom";

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { roomId } = await params;
  const { mode } = await searchParams;
  return <BattleRoom roomId={roomId.toUpperCase()} role={mode === "create" ? "host" : "guest"} />;
}
