const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const loginUrl = 'https://wsdx.hzau.edu.cn/login/#/login';
const username = '你的账户';
const password = '你的密码';
const refererUrl = 'https://wsdx.hzau.edu.cn/ybdy/lesson/video?lesson_id=808';
const captchaPath = path.join(__dirname, 'captcha.png');
const videoListFile = path.join(__dirname, 'video-list.txt');

// 读取视频列表
function loadVideoList() {
  if (!fs.existsSync(videoListFile)) {
    console.error(`视频列表文件不存在: ${videoListFile}`);
    console.error('请创建该文件，每行一个视频ID或完整URL');
    process.exit(1);
  }
  
  const content = fs.readFileSync(videoListFile, 'utf-8');
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#')); // 支持 # 注释
  
  const videos = [];
  for (const line of lines) {
    if (line.startsWith('http://') || line.startsWith('https://')) {
      // 完整URL
      videos.push(line);
    } else {
      // 仅数字ID，构建完整URL
      const videoId = line;
      videos.push(`https://wsdx.hzau.edu.cn/ybdy/play?v_id=${videoId}&r=video&t=2`);
    }
  }
  
  return videos;
}

const videoList = loadVideoList();
console.log(`已加载 ${videoList.length} 个视频`);

if (!username || !password || videoList.length === 0) {
  console.error('请先设置账号密码，并确保视频列表文件中有内容');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function saveCaptcha(page) {
  try {
    const captchaEl = await page.$('img.login_piccheck_img');
    if (!captchaEl) return null;
    await captchaEl.screenshot({ path: captchaPath });
    console.log(`验证码已保存: ${captchaPath}`);
    return captchaPath;
  } catch (e) {
    return null;
  }
}

// 提取视频分集列表（包含完成状态）
async function extractEpisodes(page, baseUrl) {
  try {
    // 等待页面加载完成，特别是分集列表
    await page.waitForSelector('.video_lists ul, video#video', { timeout: 10000 });
    
    const episodes = await page.evaluate((baseUrl) => {
      const episodeList = [];
      // 查找分集列表
      const listContainer = document.querySelector('.video_lists ul');
      if (listContainer) {
        const listItems = listContainer.querySelectorAll('li');
        listItems.forEach(li => {
          const link = li.querySelector('a[href*="r_id="]');
          if (link) {
            const href = link.getAttribute('href');
            if (href) {
              // 将相对路径转换为绝对路径
              const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
              
              // 检测完成状态
              // 检查类名
              const classes = Array.from(li.classList);
              const hasVideoRed2 = li.classList.contains('video_red2');
              const hasVideoRed3 = li.classList.contains('video_red3');
              
              // 检查链接的内联样式（已完成的分集链接通常有 style="color:red"）
              const linkStyle = link.getAttribute('style') || '';
              const hasInlineRedStyle = linkStyle.includes('color:red') || 
                                       linkStyle.includes('color: red') ||
                                       linkStyle.includes('color:#ef0312') ||
                                       linkStyle.includes('color:#e61d1d');
              
              // 检查链接和文字的计算颜色（已完成的链接通常是红色）
              const linkColor = window.getComputedStyle(link).color;
              const spanColor = li.querySelector('span') ? window.getComputedStyle(li.querySelector('span')).color : '';
              const isRedColor = linkColor.includes('rgb(239, 3, 18)') || 
                                linkColor.includes('rgb(230, 29, 29)') ||
                                linkColor.includes('#ef0312') ||
                                linkColor.includes('#e61d1d') ||
                                spanColor.includes('rgb(239, 3, 18)') || 
                                spanColor.includes('rgb(230, 29, 29)') ||
                                spanColor.includes('#ef0312') ||
                                spanColor.includes('#e61d1d');
              
              // 检查文本内容
              const textContent = li.textContent || '';
              const hasCompletedText = textContent.includes('已完成') || 
                                      textContent.includes('完成');
              
              // 检查是否有完成图标（通过背景图片判断）
              const bgImage = window.getComputedStyle(li).backgroundImage;
              const hasCompletedIcon = bgImage && (
                bgImage.includes('video_ico2') || 
                bgImage.includes('video_ico3')
              );
              
              // 综合判断：如果有红色内联样式、红色计算样式、完成图标或完成文字，则认为已完成
              // 注意：video_red1 是当前播放的，但如果链接是红色，说明已完成
              const isCompleted = hasInlineRedStyle || 
                                 hasVideoRed2 || 
                                 hasVideoRed3 || 
                                 hasCompletedIcon || 
                                 (isRedColor && !li.classList.contains('video_red1')) || 
                                 hasCompletedText;
              
              episodeList.push({
                url: fullUrl,
                title: link.textContent.trim(),
                completed: isCompleted,
                // 调试信息
                debug: {
                  classes: classes.join(','),
                  hasVideoRed2: hasVideoRed2,
                  hasVideoRed3: hasVideoRed3,
                  hasInlineRedStyle: hasInlineRedStyle,
                  isRedColor: isRedColor,
                  hasCompletedText: hasCompletedText,
                  hasCompletedIcon: hasCompletedIcon
                }
              });
            }
          }
        });
      }
      return episodeList;
    }, baseUrl);
    
    // 返回所有分集（包括只有一集的情况），以便检测完成状态
    return episodes;
  } catch (e) {
    // 如果提取失败，返回空数组（当作单个视频处理）
    return [];
  }
}

// 检测当前视频是否已完成（用于单个视频的情况）
async function checkVideoCompleted(page) {
  try {
    await page.waitForSelector('.video_lists ul, video#video', { timeout: 5000 });
    const isCompleted = await page.evaluate(() => {
      // 检查分集列表中的当前项是否标记为已完成
      const listContainer = document.querySelector('.video_lists ul');
      if (listContainer) {
        // 查找当前播放的视频项（通常有 video_red1 类名表示正在播放）
        const currentItem = listContainer.querySelector('li.video_red1, li.video_red2, li.video_red3');
        if (currentItem) {
          // 如果当前项有 video_red2 或 video_red3，表示已完成
          return currentItem.classList.contains('video_red2') || 
                 currentItem.classList.contains('video_red3') ||
                 currentItem.textContent.includes('已完成') ||
                 currentItem.textContent.includes('完成');
        }
      }
      return false;
    });
    return isCompleted;
  } catch (e) {
    return false;
  }
}

// 播放单个视频（可能是分集中的一集）
async function playSingleVideo(page, videoUrl, videoIndex, totalVideos, episodeIndex = null, totalEpisodes = null) {
  const episodeInfo = episodeIndex !== null ? ` [分集 ${episodeIndex}/${totalEpisodes}]` : '';
  console.log(`\n[${videoIndex}/${totalVideos}]${episodeInfo} 开始播放: ${videoUrl}`);
  
  try {
    await page.goto(videoUrl, {
      waitUntil: 'domcontentloaded',
      referer: refererUrl,
    });
  } catch (e) {
    console.warn('直接跳转失败，尝试带 referer 重试', e.message);
    await page.goto(videoUrl, {
      waitUntil: 'domcontentloaded',
      referer: refererUrl,
    });
  }
  
  await page.waitForSelector('video#video', { timeout: 30000 });

  // 注入前端反挂机补丁，并保持 1 倍速播放，同时静音
  await page.evaluate(() => {
    // 保持页面"可见"
    const redefine = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, {
          configurable: true,
          get: () => value,
        });
      } catch (e) {}
    };
    redefine(document, 'hidden', false);
    redefine(document, 'visibilityState', 'visible');

    // 忽略后续 visibilitychange 监听
    const nativeAdd = document.addEventListener.bind(document);
    document.addEventListener = function (type, listener, options) {
      if (type === 'visibilitychange') return;
      return nativeAdd(type, listener, options);
    };

    // 拦截已有的 visibilitychange 处理（若已注册）
    document.onvisibilitychange = null;

    // 禁用周期性强制暂停
    if (typeof window.loop_pause === 'function') {
      window.loop_pause = () => {};
    }

    // 确保倍速被锁定为 1，并设置静音
    if (window.player && window.player.media) {
      window.player.media.playbackRate = 1;
      window.player.media.muted = true; // 静音
      window.player.on('ratechange', () => {
        if (window.player.media.playbackRate !== 1) {
          window.player.media.playbackRate = 1;
        }
      });
    }
    
    // 直接设置 video 元素静音（备用方案）
    const v = document.querySelector('video#video');
    if (v) {
      v.muted = true;
      // 监听 muted 属性变化，确保始终静音
      const observer = new MutationObserver(() => {
        if (!v.muted) v.muted = true;
      });
      observer.observe(v, { attributes: true, attributeFilter: ['muted'] });
    }
  });

  // 播放守护：定期检查并恢复播放（不修改心跳）
  const keepPlaying = async () => {
    try {
      await page.evaluate(() => {
        const tryPlay = () => {
          if (window.player && typeof window.player.play === 'function') {
            if (window.player.paused) window.player.play();
            return;
          }
          const v = document.querySelector('video');
          if (v && v.paused && typeof v.play === 'function') v.play();
        };
        tryPlay();
      });
    } catch (e) {
      // 忽略一次性错误
    }
  };

  await keepPlaying();
  const interval = setInterval(keepPlaying, 10000);

  // 播放状态监控：定期输出播放进度和状态
  let statusInterval;
  const monitorStatus = async () => {
    try {
      const status = await page.evaluate(() => {
        const v = document.querySelector('video#video');
        if (!v) return null;
        
        const currentTime = v.currentTime || 0;
        const duration = v.duration || 0;
        const progress = duration > 0 ? (currentTime / duration * 100).toFixed(1) : 0;
        const isPlaying = !v.paused && !v.ended;
        const isEnded = v.ended;
        
        // 格式化时间显示
        const formatTime = (seconds) => {
          if (!seconds || !isFinite(seconds)) return '00:00';
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = Math.floor(seconds % 60);
          if (h > 0) {
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
          }
          return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        };
        
        return {
          currentTime: formatTime(currentTime),
          duration: formatTime(duration),
          progress: progress,
          isPlaying: isPlaying,
          isEnded: isEnded,
          status: isEnded ? '已结束' : (isPlaying ? '播放中' : '暂停'),
        };
      });
      
      if (status) {
        const episodeInfo = episodeIndex !== null ? ` [分集 ${episodeIndex}/${totalEpisodes}]` : '';
        // 使用 \r 在同一行更新状态，避免刷屏
        process.stdout.write(
          `\r[${videoIndex}/${totalVideos}]${episodeInfo} ${status.status} | ${status.currentTime}/${status.duration} | ${status.progress}%        `
        );
      }
    } catch (e) {
      // 忽略监控错误
    }
  };
  
  // 立即显示一次状态
  await monitorStatus();
  // 每 3 秒更新一次状态
  statusInterval = setInterval(monitorStatus, 3000);

  // 等待视频播放完成
  return new Promise((resolve) => {
    let videoEnded = false;
    let checkInterval;
    
    // 设置视频结束监听器
    page.evaluate(() => {
      return new Promise((resolve) => {
        const checkVideo = () => {
          const v = document.querySelector('video#video');
          if (v) {
            // 如果视频已经结束
            if (v.ended) {
              resolve(true);
              return;
            }
            // 监听结束事件
            v.addEventListener('ended', () => {
              resolve(true);
            }, { once: true });
          } else {
            // 如果找不到视频元素，等待一下再检查
            setTimeout(checkVideo, 1000);
          }
        };
        checkVideo();
      });
    }).then(() => {
      if (!videoEnded) {
        videoEnded = true;
        clearInterval(interval);
        if (statusInterval) clearInterval(statusInterval);
        if (checkInterval) clearInterval(checkInterval);
        // 换行并显示完成信息
        const episodeInfo = episodeIndex !== null ? ` [分集 ${episodeIndex}/${totalEpisodes}]` : '';
        console.log(`\n[${videoIndex}/${totalVideos}]${episodeInfo} 视频播放完成`);
        resolve();
      }
    }).catch(() => {
      // 如果监听失败，依赖定期检查
    });

    // 备用检查：定期检查视频状态（防止事件未触发）
    checkInterval = setInterval(async () => {
      try {
        const ended = await page.evaluate(() => {
          const v = document.querySelector('video#video');
          return v && v.ended;
        });
        if (ended && !videoEnded) {
          videoEnded = true;
          clearInterval(interval);
          if (statusInterval) clearInterval(statusInterval);
          clearInterval(checkInterval);
          // 换行并显示完成信息
          const episodeInfo = episodeIndex !== null ? ` [分集 ${episodeIndex}/${totalEpisodes}]` : '';
          console.log(`\n[${videoIndex}/${totalVideos}]${episodeInfo} 视频播放完成（通过状态检查）`);
          resolve();
        }
      } catch (e) {
        // 忽略检查错误
      }
    }, 5000);
  });
}

async function loginAndPlay() {
  const browser = await chromium.launch({
    headless: false, // 需要前台避免隐藏暂停
    args: [
      '--disable-features=IsolateOrigins,site-per-process',
      '--mute-audio', // 浏览器静音
      '--disable-blink-features=AutomationControlled', // 隐藏自动化控制特征
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  const page = await context.newPage();
  
  // 隐藏自动化特征
  await page.addInitScript(() => {
    // 删除 webdriver 特征
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    
    // 伪装 Chrome 对象
    window.chrome = {
      runtime: {},
    };
    
    // 伪装插件（避免被检测为无插件浏览器）
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // 伪装语言
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'],
    });
  });

  // 登录
  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="请输入您的学号/工号"]', username);
  await page.fill('input[placeholder="请输入您的密码"]', password);

  await saveCaptcha(page);
  const captcha = await ask('请输入验证码（如页面未出现验证码可直接回车）: ');
  if (captcha) {
    await page.fill('input[placeholder="验证码"]', captcha.trim());
  }

  await page.click('button.login_btn:has-text("登录")');
  await page.waitForLoadState('networkidle');
  console.log('登录完成，开始依次播放视频列表...\n');

  // 依次播放每个视频
  for (let i = 0; i < videoList.length; i++) {
    try {
      const videoUrl = videoList[i];
      
      // 先访问视频页面，检查是否有分集
      try {
        await page.goto(videoUrl, {
          waitUntil: 'domcontentloaded',
          referer: refererUrl,
          timeout: 30000,
        });
      } catch (e) {
        // 如果直接访问失败，尝试先访问主页面再访问视频
        console.warn(`[${i + 1}/${videoList.length}] 直接访问失败，尝试从主页面访问...`);
        try {
          // 尝试从课程页面访问
          const lessonUrl = refererUrl || 'https://wsdx.hzau.edu.cn/ybdy/lesson/video';
          await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000);
          await page.goto(videoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
        } catch (e2) {
          console.error(`[${i + 1}/${videoList.length}] 访问视频页面失败:`, e2.message);
          console.log('跳过该视频，继续下一个...');
          continue;
        }
      }
      
      // 等待页面加载，然后提取分集列表
      await page.waitForTimeout(3000); // 增加等待时间，确保页面完全加载
      const episodes = await extractEpisodes(page, videoUrl);
      
      if (episodes.length > 1) {
        // 有多个分集，过滤出未完成的分集
        const uncompletedEpisodes = episodes.filter(ep => !ep.completed);
        const completedCount = episodes.length - uncompletedEpisodes.length;
        
        // 输出调试信息
        if (completedCount > 0 || episodes.some(ep => ep.debug)) {
          console.log(`\n[${i + 1}/${videoList.length}] 分集检测详情:`);
          episodes.forEach((ep, idx) => {
            console.log(`  分集 ${idx + 1}: ${ep.title}`);
            console.log(`    完成状态: ${ep.completed ? '是' : '否'}`);
            if (ep.debug) {
              console.log(`    类名: ${ep.debug.classes || '无'}`);
              console.log(`    内联红色样式: ${ep.debug.hasInlineRedStyle ? '是' : '否'}`);
              console.log(`    计算红色样式: ${ep.debug.isRedColor ? '是' : '否'}`);
              console.log(`    完成图标: ${ep.debug.hasCompletedIcon ? '是' : '否'}`);
            }
          });
        }
        
        if (completedCount > 0) {
          console.log(`\n[${i + 1}/${videoList.length}] 检测到 ${episodes.length} 个分集，其中 ${completedCount} 个已完成，将跳过`);
        } else {
          console.log(`\n[${i + 1}/${videoList.length}] 检测到 ${episodes.length} 个分集，开始依次播放...`);
        }
        
        if (uncompletedEpisodes.length === 0) {
          console.log(`[${i + 1}/${videoList.length}] 所有分集已完成，跳过`);
        } else {
          // 依次播放未完成的分集
          for (let j = 0; j < uncompletedEpisodes.length; j++) {
            const episode = uncompletedEpisodes[j];
            try {
              await playSingleVideo(page, episode.url, i + 1, videoList.length, j + 1, uncompletedEpisodes.length);
              // 分集播放完成后等待一小段时间再播放下一个
              if (j < uncompletedEpisodes.length - 1) {
                await page.waitForTimeout(2000);
              }
            } catch (e) {
              console.error(`[${i + 1}/${videoList.length}] [分集 ${j + 1}/${uncompletedEpisodes.length}] 播放出错:`, e.message);
              console.log('继续播放下一个分集...');
              await page.waitForTimeout(2000);
            }
          }
          console.log(`\n[${i + 1}/${videoList.length}] 所有未完成分集播放完成`);
        }
      } else if (episodes.length === 1) {
        // 只有一集，检查是否已完成
        const episode = episodes[0];
        
        // 输出调试信息
        if (episode.debug) {
          console.log(`\n[${i + 1}/${videoList.length}] 单集视频检测详情:`);
          console.log(`  标题: ${episode.title}`);
          console.log(`  完成状态: ${episode.completed ? '是' : '否'}`);
          console.log(`  类名: ${episode.debug.classes || '无'}`);
          console.log(`  内联红色样式: ${episode.debug.hasInlineRedStyle ? '是' : '否'}`);
          console.log(`  计算红色样式: ${episode.debug.isRedColor ? '是' : '否'}`);
          console.log(`  完成图标: ${episode.debug.hasCompletedIcon ? '是' : '否'}`);
        }
        
        if (episode.completed) {
          console.log(`\n[${i + 1}/${videoList.length}] 视频已完成，跳过`);
        } else {
          // 未完成，播放该视频
          await playSingleVideo(page, episode.url, i + 1, videoList.length);
        }
      } else {
        // 没有检测到分集列表，可能是单个视频，检查当前页面是否已完成
        const isCompleted = await checkVideoCompleted(page);
        if (isCompleted) {
          console.log(`\n[${i + 1}/${videoList.length}] 视频已完成，跳过`);
        } else {
          // 未完成，直接播放
          await playSingleVideo(page, videoUrl, i + 1, videoList.length);
        }
      }
      
      // 视频播放完成后等待一小段时间再播放下一个
      await page.waitForTimeout(2000);
    } catch (e) {
      console.error(`[${i + 1}/${videoList.length}] 播放出错:`, e.message);
      console.log('继续播放下一个视频...');
      await page.waitForTimeout(2000);
    }
  }

  console.log('\n所有视频播放完成！');
  await browser.close();
  rl.close();
}

loginAndPlay().catch((err) => {
  console.error('执行出错', err);
  rl.close();
  process.exit(1);
});

