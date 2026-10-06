import sys

def resolve_conflicts(filepath):
    with open(filepath, 'r') as f:
        lines = f.readlines()

    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('<<<<<<<'):
            # Found a conflict
            head_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith('======='):
                head_lines.append(lines[i])
                i += 1
            
            incoming_lines = []
            if i < len(lines) and lines[i].startswith('======='):
                i += 1
                while i < len(lines) and not lines[i].startswith('>>>>>>>'):
                    incoming_lines.append(lines[i])
                    i += 1
            
            if i < len(lines) and lines[i].startswith('>>>>>>>'):
                i += 1
            
            # Resolution logic based on context
            content = "".join(head_lines + incoming_lines)
            
            # Special case for RepositoryContext (the first conflict)
            if 'mutationSnapshotRepo' in content and 'overlayRepo' in content:
                # Merge them and ensure proper closing brace
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
            
            # Special case for createOrder
            elif 'createOrder' in lines[i-30:i+30] or 'CREATE_ORDER' in content:
                # Integrate Overlay logic into createOrder
                # We want to keep the preparation but use the overlay path
                # Actually, I'll just keep the incoming_lines if they look like Phase 1.1
                if 'Phase 1.1: Use Overlay' in content:
                     new_lines.extend(incoming_lines)
                else:
                     new_lines.extend(head_lines)
            
            # Special case for addOrderItem
            elif 'ADD_ORDER_ITEM' in content:
                if 'Phase 1.1: Use Overlay' in content:
                    new_lines.extend(incoming_lines)
                else:
                    new_lines.extend(head_lines)
            
            # Special case for deliverOrderItem
            elif 'DELIVER_ORDER_ITEM' in content:
                if 'Phase 1.1: Use Overlay' in content:
                    new_lines.extend(incoming_lines)
                else:
                    new_lines.extend(head_lines)

            else:
                # Default to incoming (the one with the commit hash) as it's usually the newer one
                new_lines.extend(incoming_lines)
        else:
            new_lines.append(line)
            i += 1

    with open(filepath, 'w') as f:
        f.writelines(new_lines)

if __name__ == "__main__":
    resolve_conflicts(sys.argv[1])
