import sys
import os

def resolve():
    filepath = 'src/application/useCases.ts'
    if not os.path.exists(filepath):
        print(f"File {filepath} not found")
        return

    with open(filepath, 'r') as f:
        lines = f.readlines()

    new_lines = []
    i = 0
    while i < len(lines):
        if '<<<<<<< HEAD' in lines[i]:
            head = []
            i += 1
            while i < len(lines) and '=======' not in lines[i]:
                head.append(lines[i])
                i += 1
            
            incoming = []
            if i < len(lines) and '=======' in lines[i]:
                i += 1
                while i < len(lines) and '>>>>>>>' not in lines[i]:
                    incoming.append(lines[i])
                    i += 1
            
            if i < len(lines) and '>>>>>>>' in lines[i]:
                i += 1
            
            # Resolution
            content = "".join(head) + "".join(incoming)
            if 'mutationSnapshotRepo' in content and 'overlayRepo' in content:
                # Merge both
                new_lines.append('  mutationSnapshotRepo?: {\n')
                new_lines.append('    capture(commandId: ID, records: Array<{ table: string; id: ID; existed: boolean; data?: unknown }>): Promise<void> | void;\n')
                new_lines.append('    clear(commandId: ID): Promise<void> | void;\n')
                new_lines.append('  };\n')
                new_lines.append('  overlayRepo: {\n')
                new_lines.append('    save(overlay: OptimisticOverlayRecord): Promise<void> | void;\n')
                new_lines.append('    remove(commandId: ID): Promise<void> | void;\n')
                new_lines.append('    get(commandId: ID): Promise<OptimisticOverlayRecord | null> | (OptimisticOverlayRecord | null);\n')
                new_lines.append('    getNextSequence(): Promise<number> | number;\n')
                new_lines.append('  };\n')
            else:
                # Default to incoming (Phase 1.1)
                new_lines.extend(incoming)
        else:
            new_lines.append(lines[i])
            i += 1

    with open(filepath, 'w') as f:
        f.writelines(new_lines)

resolve()
