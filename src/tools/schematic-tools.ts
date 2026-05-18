import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { Schematic } from 'prismarine-schematic';
import { Vec3 } from 'vec3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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
    "Build a structure from a schematic file, placing blocks one by one starting at CALEB's current position. CALEB must have the required blocks in inventory (or be in creative mode). Large structures will take time — CALEB will report progress.",
    {
      filename: z.string().describe("Exact filename of the schematic to build, including extension (e.g. 'smallhouse.schem')"),
      offsetX: z.coerce.number().finite().optional().describe("X offset from CALEB's position to start building (default: 0)"),
      offsetY: z.coerce.number().finite().optional().describe("Y offset — use 0 to build at current level (default: 0)"),
      offsetZ: z.coerce.number().finite().optional().describe("Z offset from CALEB's position to start building (default: 0)"),
      delayMs: z.coerce.number().finite().optional().describe("Delay in milliseconds between placing each block. Lower is faster (default: 250)")
    },
    async ({ filename, offsetX = 0, offsetY = 0, offsetZ = 0, delayMs = 250 }) => {
      const bot = getBot();
      ensureSchematicsDir();

      // Safety: strip any path traversal attempts
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

      let schematic: Schematic;
      try {
        const buffer = fs.readFileSync(filePath);
        schematic = await Schematic.read(buffer);
      } catch (err) {
        return factory.createErrorResponse(`Failed to read schematic: ${(err as Error).message}`);
      }

      const origin = bot.entity.position.floored().offset(offsetX, offsetY, offsetZ);
      const size = schematic.size;

      // Count total blocks to place (skip air)
      let totalBlocks = 0;
      schematic.forEach((block) => {
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
          totalBlocks++;
        }
      });

      if (totalBlocks === 0) {
        return factory.createResponse("Schematic appears to be empty or contains only air blocks.");
      }

      // Announce start
      await bot.chat(`Starting build: ${safeName} (${totalBlocks} blocks, ${size.x}x${size.y}x${size.z})`);

      let placed = 0;
      let failed = 0;
      const errors: string[] = [];

      // Place blocks — bottom to top so we don't block ourselves
      const blockList: { pos: Vec3; name: string }[] = [];

      schematic.forEach((block, pos) => {
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
          blockList.push({
            pos: new Vec3(
              origin.x + pos.x,
              origin.y + pos.y,
              origin.z + pos.z
            ),
            name: block.name
          });
        }
      });

      // Sort bottom-up so scaffolding works naturally
      blockList.sort((a, b) => a.pos.y - b.pos.y);

      for (const { pos, name } of blockList) {
        try {
          // Find the block in inventory
          const item = bot.inventory.items().find(i => i.name === name);
          if (!item) {
            failed++;
            if (errors.length < 5) {
              errors.push(`Missing: ${name}`);
            }
            continue;
          }

          await bot.equip(item, 'hand');

          // Move near the target position if too far
          const dist = bot.entity.position.distanceTo(pos);
          if (dist > 4) {
            await bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalNear)(pos.x, pos.y, pos.z, 3));
          }

          // Place the block
          const referenceBlock = bot.blockAt(pos.offset(0, -1, 0));
          if (referenceBlock) {
            await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
            placed++;
          } else {
            failed++;
          }

          // Progress report every 25 blocks
          if (placed % 25 === 0) {
            await bot.chat(`Building... ${placed}/${totalBlocks} blocks placed`);
          }

          // Respect delay
          await new Promise(resolve => setTimeout(resolve, delayMs));

        } catch {
          failed++;
        }
      }

      const summary = `Build complete: ${placed}/${totalBlocks} blocks placed` +
        (failed > 0 ? `, ${failed} failed` : '') +
        (errors.length > 0 ? `\nMissing materials: ${errors.join(', ')}` : '');

      await bot.chat(summary);
      return factory.createResponse(summary);
    }
  );
}
