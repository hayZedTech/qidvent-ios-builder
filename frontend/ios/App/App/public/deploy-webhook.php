<?php
/**
 * Qidvent Automated Deployment Webhook & Server Manager (PHP Runner)
 * Production URL: https://qidvent.com/deploy-webhook.php
 * Triggers git pull/reset, public_html sync, and Passenger Node app restart.
 */

// Deployment Configuration
$secret = getenv('DEPLOY_WEBHOOK_SECRET') ?: 'qidvent_deploy_secret_2026';
$repo_path = '/home/qidvshpu/repositories/Inventory_Jimm';
$public_html_path = '/home/qidvshpu/public_html';

header('Content-Type: application/json');

$query_secret = $_GET['secret'] ?? '';
$action = $_GET['action'] ?? '';
$header_secret = $_SERVER['HTTP_X_WEBHOOK_SECRET'] ?? '';
$signature = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$payload = file_get_contents('php://input');

// Authentication check
$authorized = false;
if (!empty($query_secret) && hash_equals($secret, $query_secret)) {
    $authorized = true;
} elseif (!empty($header_secret) && hash_equals($secret, $header_secret)) {
    $authorized = true;
} elseif (!empty($signature)) {
    $expected = 'sha256=' . hash_hmac('sha256', $payload, $secret);
    if (hash_equals($expected, $signature)) {
        $authorized = true;
    }
}

// 1. GET Request Handling
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (!$authorized) {
        echo json_encode([
            'status' => 'PHP Deploy Webhook Active',
            'url' => 'https://qidvent.com/deploy-webhook.php',
            'repo' => $repo_path,
            'instructions' => 'Pass ?secret=... with &action=diag, &action=restart, or &action=deploy, or send a POST push webhook.'
        ]);
        exit;
    }

    if ($action === 'diag') {
        $diag = [];
        exec("whoami", $diag['whoami']);
        exec("date", $diag['date']);
        exec("git -C {$repo_path} branch -a 2>&1", $diag['branches']);
        exec("git -C {$repo_path} log -n 3 --oneline 2>&1", $diag['recent_commits']);
        exec("git -C {$repo_path} status --short 2>&1", $diag['git_status']);
        exec("ls -la {$repo_path}/backend/tmp/ 2>&1", $diag['backend_tmp_files']);
        exec("tail -n 80 {$repo_path}/backend/logs/error.log 2>&1", $diag['backend_error_log']);
        exec("tail -n 40 {$repo_path}/backend/logs/combined.log 2>&1", $diag['backend_combined_log']);
        echo json_encode(['success' => true, 'action' => 'diagnostics', 'data' => $diag], JSON_PRETTY_PRINT);
        exit;
    }

    if ($action === 'restart' || $action === 'kill') {
        $res = [];
        $cmds = [
            "mkdir -p {$repo_path}/backend/tmp {$repo_path}/tmp {$public_html_path}/tmp 2>&1",
            "touch {$repo_path}/backend/tmp/restart.txt {$repo_path}/tmp/restart.txt {$public_html_path}/tmp/restart.txt 2>&1",
            "pkill -9 -u qidvshpu -f 'lsnode' 2>&1 || true",
            "pkill -9 -u qidvshpu -f 'node' 2>&1 || true",
            "pkill -9 -u qidvshpu -f 'Passenger' 2>&1 || true",
            "pkill -9 -u qidvshpu -f 'Inventory_Jimm' 2>&1 || true"
        ];
        if (!empty($_GET['pid'])) {
            $pid = intval($_GET['pid']);
            $cmds[] = "kill -9 {$pid} 2>&1 || true";
        }
        foreach ($cmds as $cmd) {
            $cmd_out = [];
            exec($cmd, $cmd_out, $code);
            $res[] = ['cmd' => $cmd, 'exit' => $code, 'output' => implode("\n", $cmd_out)];
        }
        echo json_encode(['success' => true, 'message' => 'Node/lsnode process killed and restart signaled', 'results' => $res], JSON_PRETTY_PRINT);
        exit;
    }
}

// 2. POST / Deploy Execution
if (!$authorized) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized', 'message' => 'Invalid or missing signature/secret']);
    exit;
}

// Handle GitHub Ping
$event = $_SERVER['HTTP_X_GITHUB_EVENT'] ?? 'push';
if ($event === 'ping') {
    echo json_encode(['success' => true, 'message' => 'GitHub Ping received successfully via PHP webhook!']);
    exit;
}

$data = json_decode($payload, true);
$branch = isset($data['ref']) ? str_replace('refs/heads/', '', $data['ref']) : 'main';

if ($branch !== 'main' && $branch !== 'hayzed' && $action !== 'deploy') {
    echo json_encode(['success' => true, 'message' => "Ignored push to branch: {$branch}"]);
    exit;
}

if (!is_dir($repo_path)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => "Repository directory not found at {$repo_path}"]);
    exit;
}

// Full deployment pipeline
$steps = [
    "git -C {$repo_path} fetch origin 2>&1",
    "git -C {$repo_path} reset --hard origin/main 2>&1",
    "cp -a {$repo_path}/backend/public/. {$public_html_path}/ 2>&1",
    "mkdir -p {$repo_path}/backend/tmp {$repo_path}/tmp {$public_html_path}/tmp 2>&1",
    "touch {$repo_path}/backend/tmp/restart.txt {$repo_path}/tmp/restart.txt {$public_html_path}/tmp/restart.txt 2>&1",
    "pkill -9 -u qidvshpu -f 'lsnode' 2>&1 || true",
    "pkill -9 -u qidvshpu -f 'node' 2>&1 || true",
    "pkill -9 -u qidvshpu -f 'Passenger' 2>&1 || true",
    "pkill -9 -u qidvshpu -f 'Inventory_Jimm' 2>&1 || true"
];

$step_results = [];
$all_success = true;

foreach ($steps as $cmd) {
    $out = [];
    $ret = 0;
    exec($cmd, $out, $ret);
    $step_results[] = [
        'command' => $cmd,
        'exit_code' => $ret,
        'output' => implode("\n", $out)
    ];
    if ($ret !== 0 && !str_contains($cmd, 'pkill')) {
        $all_success = false;
    }
}

echo json_encode([
    'success' => $all_success,
    'message' => $all_success ? 'Deployment completed successfully!' : 'Deployment finished with warnings/errors',
    'branch' => $branch,
    'steps' => $step_results
], JSON_PRETTY_PRINT);
