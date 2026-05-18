import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const { GoalNear } = goals;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMATICS_DIR = path.resolve(__dirname, '../../schematics');

function ensureSchematicsDir() {
  if (!fs.existsSync(SCHEMATICS_DIR)) {
    fs.mkdirSync(SCHEMATICS_DIR, { recursive: true });
  }
}

export function registerSchematicTools(factory: ToolFactory, getBot: () => Bot): void {

  // ── LIST SCHEMATICS ────────────────────────────────────────────────────────
  factory.registerTool(
    "list-schematics",
    "List all available schematic files that CALEB can build. Files must be in the schematics/ folder with .schem or .schematic extension.",
    {},
    async () => {
      ensureSchematicsDir();

      const files = fs.readdirSync(SCHEMATICS_DIR).filter(f =>
        f.endsWith('.schem') || f.endsWith('.schematic')
      );

      if (files.length === 0) {
        return factory.createResponse(
          "No schematic files found. Add .schem or .schematic files to the schematics/ folder in the server directory."
        );
      }

      return factory.createResponse(
        `Available schematics (${files.length}):\n${files.join('\n')}\n\nUse build-schematic with the exact filename to build one.`
      );
    }
  );

  // ── BUILD SCHEMATIC ────────────────────────────────────────────────────────
  factory.registerTool(
    "build-schematic",
    "Build a structure from a schematic file, placing blocks one by one starting at CALEB's current position. CALEB must have the required blocks in inventory (or be in creative mode). Large structures will take time — CALEB will report progress in Minecraft chat.",
    {
      filename: z.string().describe("Exact filename of the schematic to build, including extension (e.g. 'smallhouse.schem')"),
      offsetX: z.coerce.number().finite().optional().describe("X offset from CALEB's position to start building (default: 0)"),
      offsetY: z.coerce.number().finite().optional().describe("Y offset — use 0 to build at current level (default: 0)"),
      offsetZ: z.coerce.number().finite().optional().describe("Z offset from CALEB's position to start building (default: 0)"),
      delayMs: z.coerce.number().finite().optional().describe("Milliseconds between placing each block — lower is faster (default: 250)")
    },
    async ({ filename, offsetX = 0, offsetY = 0, offsetZ = 0, delayMs = 250 }) => {
      const bot = getBot();
      ensureSchematicsDir();

      const safeName = path.basename(filename);
      const filePath = path.join(SCHEMATICS_DIR, safeName);

      if (!fs.existsSync(filePath)) {
        return factory.createResponse(
          `Schematic '${safeName}' not found. Use list-schematics to see available files.`
        );
      }

      if (!safeName.endsWith('.schem') && !safeName.endsWith('.schematic')) {
        return factory.createResponse("File must be a .schem or .schematic file.");
      }

      const { Schematic } = await import('prismarine-schematic');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let schematic: any;
      try {
        const buffer = fs.readFileSync(filePath);
        schematic = await Schematic.read(buffer);
      } catch (err) {
        return factory.createErrorResponse(`Failed to read schematic: ${(err as Error).message}`);
      }

      const origin = bot.entity.position.floored().offset(offsetX, offsetY, offsetZ);
      const size = schematic.size as Vec3;

      // Iterate using x/y/z loops and getBlock() — the correct API
      const blockList: { pos: Vec3; name: string }[] = [];

      for (let y = 0; y < size.y; y++) {
        for (let z = 0; z < size.z; z++) {
          for (let x = 0; x < size.x; x++) {
            const localPos = new Vec3(x, y, z);
            const block = schematic.getBlock(localPos);
            if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
              blockList.push({
                pos: new Vec3(
                  origin.x + x,
                  origin.y + y,
                  origin.z + z
                ),
                name: block.name
              });
            }
          }
        }
      }

      if (blockList.length === 0) {
        return factory.createResponse("Schematic appears to be empty or contains only air blocks.");
      }

      // Already sorted bottom-up by the y loop
      const totalBlocks = blockList.length;
      await bot.chat(`Starting build: ${safeName} (${totalBlocks} blocks, ${size.x}x${size.y}x${size.z})`);

      let placed = 0;
      let failed = 0;
      const missingMaterials = new Set<string>();

      for (const { pos, name } of blockList) {
        try {
          const item = bot.inventory.items().find(i => i.name === name);
          if (!item) {
            failed++;
            missingMaterials.add(name);
            continue;
          }

          await bot.equip(item, 'hand');

          const dist = bot.entity.position.distanceTo(pos);
          if (dist > 4) {
            await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 3));
          }

          const referenceBlock = bot.blockAt(pos.offset(0, -1, 0));
          if (referenceBlock) {
            await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
            placed++;
          } else {
            failed++;
          }

          if (placed > 0 && placed % 25 === 0) {
            await bot.chat(`Building... ${placed}/${totalBlocks} blocks placed`);
          }

          await new Promise(resolve => setTimeout(resolve, delayMs));

        } catch {
          failed++;
        }
      }

      const missing = missingMaterials.size > 0
        ? `\nMissing materials: ${[...missingMaterials].join(', ')}`
        : '';
      const summary = `Build complete: ${placed}/${totalBlocks} blocks placed${failed > 0 ? `, ${failed} failed` : ''}${missing}`;

      await bot.chat(summary);
      return factory.createResponse(summary);
    }
  );
}
