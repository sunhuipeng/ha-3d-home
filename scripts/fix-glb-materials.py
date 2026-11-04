#!/usr/bin/env python3
"""
修复 GLB 模型材质问题（零依赖，纯标准库）。

针对 Quaternius 等免费模型库的通病（放进 3D 场景发黑的根源）：
1. baseColorFactor 没做 sRGB -> 线性空间转换，颜色发黑发闷
   -> 无贴图且过暗的材质做 gamma 提亮 pow(c, 1/2.2)（幂等：修过的不重复提亮）
2. metallic 偏高（如 0.4），无环境贴图的场景里接近全黑
   -> metallic 置 0，roughness 提到 >= 0.7

用法:
  python3 scripts/fix-glb-materials.py              # 默认扫描项目 assets/ + custom/（含插件模型）：
                                                    #   先检查报告问题，再批量原地修复
  python3 scripts/fix-glb-materials.py --check      # 只检查不修改
  python3 scripts/fix-glb-materials.py model.glb    # 修指定文件（可传多个文件/目录，目录递归收集 .glb）
  python3 scripts/fix-glb-materials.py ~/Downloads --out ./fixed   # 修复版另存（保留目录结构）

原地修复时会先把原文件备份到项目根 backups/<相对路径>（同名直接覆盖）。

判定规则（参数在合适范围内不再调整，可重复运行）:
  - 最亮通道 <= 0.05  -> 视为有意的纯黑，不动颜色
  - 最亮通道 <  0.25  -> sRGB 颜色被当线性存了，gamma 提亮（>= 0.25 视为亮度合适）
  - metallic > 0.05   -> 压到 0（factor 与 metallicRoughness 贴图相乘，有贴图同样有效）
  - roughness < 0.7   -> 抬到 0.7
  - 移除 KHR_materials_specular / KHR_materials_emissive_strength 压暗扩展
"""
import json
import os
import struct
import sys

GAMMA = 1.0 / 2.2
DARK_MAX = 0.25      # 最亮通道低于此值视为「sRGB 被当线性存」
BLACK_MAX = 0.05     # 低于此值视为有意的纯黑，不动颜色

# 默认扫描的项目目录（相对脚本位置，递归收集其中所有 .glb：
# 覆盖 assets/models、assets/plugins/*/models、custom/models、custom/plugins/*/models）
PROJECT_SCAN_DIRS = ("assets", "custom")


def fix_materials(gltf):
    """按规则修复材质。返回 (实际修改处数, 待修问题清单, 提示清单)。
    问题清单非空 = 存在需要调整的材质；提示清单仅告知（如有意纯黑，不动）。"""
    n = 0
    problems = []
    notes = []
    for i, mat in enumerate(gltf.get("materials", [])):
        name = mat.get("name", f"material#{i}")
        pbr = mat.setdefault("pbrMetallicRoughness", {})
        has_tex = "baseColorTexture" in pbr
        # 1) 无贴图 -> 过暗才提亮；纯黑视为有意，只提示不动
        if not has_tex and "baseColorFactor" in pbr:
            f = pbr["baseColorFactor"]
            if len(f) >= 3:
                bright = max(f[0], f[1], f[2])
                if bright <= BLACK_MAX:
                    notes.append(f"{name}: 纯黑颜色（视为有意，不调整亮度）")
                elif bright < DARK_MAX:
                    problems.append(
                        f"{name}: 颜色过暗 max={bright:.3f}（sRGB 被当线性存），gamma 提亮")
                    rgb = [pow(min(max(c, 0.0), 1.0), GAMMA) for c in f[:3]]
                    pbr["baseColorFactor"] = rgb + list(f[3:])
                    n += 1
        # 2) 压 metallic、抬 roughness（factor 与贴图相乘，有贴图同样有效）
        if pbr.get("metallicFactor", 1.0) > 0.05:
            tag = "（factor 会与贴图相乘，可整体归零）" if "metallicRoughnessTexture" in pbr else "（无环境贴图会发黑）"
            problems.append(f"{name}: metallic={pbr['metallicFactor']:.2f} 偏高{tag}，压到 0")
            pbr["metallicFactor"] = 0.0
            n += 1
        if pbr.get("roughnessFactor", 1.0) < 0.7:
            problems.append(f"{name}: roughness={pbr['roughnessFactor']:.2f} 偏低（高光刺眼），抬到 0.7")
            pbr["roughnessFactor"] = 0.7
            n += 1
        # 3) 清掉可能压暗整体的 KHR 扩展
        for ext in ("KHR_materials_specular", "KHR_materials_emissive_strength"):
            if ext in mat.get("extensions", {}):
                problems.append(f"{name}: 移除压暗扩展 {ext}")
                mat["extensions"].pop(ext)
                n += 1
    return n, problems, notes


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"glTF":
        raise ValueError("非 GLB 文件")
    json_len, _ = struct.unpack("<II", data[12:20])
    gltf = json.loads(data[20 : 20 + json_len])
    return data, json_len, gltf


def write_glb(path, data, old_json_len, gltf, dst):
    new_json = json.dumps(gltf, separators=(",", ":")).encode()
    pad = (4 - len(new_json) % 4) % 4   # JSON chunk 4 字节对齐，空格填充
    new_json += b" " * pad

    bin_chunk = data[20 + old_json_len :]
    total = 12 + 8 + len(new_json) + len(bin_chunk)
    out = (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(new_json), 0x4E4F534A)
        + new_json
        + bin_chunk
    )
    with open(dst, "wb") as f:
        f.write(out)


def process(path, out_dir=None, check_only=False):
    """处理单个 GLB。返回: 'fixed' | 'clean' | 'problem' | 'skip'"""
    try:
        data, json_len, gltf = read_glb(path)
    except Exception as e:
        print(f"[跳过] {path}（{e}）")
        return "skip"

    n, problems, notes = fix_materials(gltf)
    for it in notes:
        print(f"    · {path}: {it}")
    if not problems:
        print(f"[健康] {path}")
        return "clean"

    for it in problems:
        print(f"    - {path}: {it}")

    if check_only:
        print(f"[待修复] {path}（{len(problems)} 项问题，--check 未修改）")
        return "problem"

    if out_dir:
        rel = os.path.relpath(path, process._base)
        dst = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    else:
        dst = path
        # 原地修复：先把原文件备份到 backups/<相对路径>（同名覆盖）
        if process._backup_dir:
            rel = os.path.relpath(path, process._base)
            bak = os.path.join(process._backup_dir, rel)
            os.makedirs(os.path.dirname(bak) or ".", exist_ok=True)
            with open(bak, "wb") as fb:
                fb.write(data)
    write_glb(path, data, json_len, gltf, dst)
    print(f"[已修复] {path}（{n} 处调整，原文件已备份）")
    return "fixed"


def collect(inputs):
    """展开输入：文件直接收，目录递归收集所有 .glb（大小写不敏感）。"""
    files = []
    for p in inputs:
        if os.path.isfile(p):
            files.append(p)
        elif os.path.isdir(p):
            for root, _, names in os.walk(p):
                for name in sorted(names):
                    if name.lower().endswith(".glb"):
                        files.append(os.path.join(root, name))
        else:
            print(f"[跳过] 路径不存在: {p}")
    return files


def main():
    args = sys.argv[1:]
    out_dir = None
    check_only = "--check" in args
    if check_only:
        args.remove("--check")
    if "--out" in args:
        i = args.index("--out")
        out_dir = args[i + 1]
        args = args[:i] + args[i + 2 :]

    # 无参数：默认扫描项目的内置 + 自定义模型目录
    if not args:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project = os.path.dirname(script_dir)
        args = [os.path.join(project, d) for d in PROJECT_SCAN_DIRS]
        print(f"未指定路径，默认扫描: {', '.join(args)}\n")

    files = collect(args)
    if not files:
        print("没有找到任何 .glb 文件")
        sys.exit(1)

    # --out 模式下记录展开前的基准路径，用于保留目录结构；原地修复时准备备份目录
    process._base = (
        os.path.commonpath([os.path.abspath(p) for p in files]) if out_dir else ""
    )
    process._backup_dir = None
    if not out_dir and not check_only:
        project = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        process._backup_dir = os.path.join(project, "backups")
        if not process._base:
            process._base = os.path.commonpath([os.path.abspath(p) for p in files])
        print(f"（原文件将备份到 {process._backup_dir}，同名覆盖）\n")

    mode = "检查" if check_only else "修复"
    print(f"共 {len(files)} 个 GLB 文件（{mode}模式）\n")

    stat = {"fixed": 0, "clean": 0, "problem": 0, "skip": 0}
    for p in files:
        try:
            stat[process(p, out_dir, check_only)] += 1
        except Exception as e:
            print(f"[出错] {p}（{e}）")
            stat["skip"] += 1

    if check_only:
        if stat["problem"]:
            print(
                f"\n检查完成：{stat['problem']}/{len(files)} 个文件有问题待修复，"
                f"{stat['clean']} 个健康，{stat['skip']} 个跳过"
            )
        else:
            print(f"\n检查完成：全部健康（跳过 {stat['skip']} 个）")
    else:
        print(
            f"\n完成：修复 {stat['fixed']} 个，健康 {stat['clean']} 个，跳过 {stat['skip']} 个"
        )


if __name__ == "__main__":
    main()
